/*
 * ACS Rx utilities.
 * Watch K8s endpoints.
 * Copyright 2023 AMRC
 */

import util     from "util";

import imm      from "immutable";
import rx       from "rxjs";

export class K8sWatcher {
    constructor (opts) {
        this.k8s        = opts.k8s;
        this.kc         = opts.kubeconfig;
        this.restart    = opts.restart ?? 5000;
        this.debounce   = opts.debounce ?? 100;
        this.errors     = opts.errors ?? (e => {});

        this.watcher    = new this.k8s.Watch(this.kc);
        this.objs       = this.k8s.KubernetesObjectApi.makeApiClient(this.kc);

        if (opts.namespace)
            this.objs.defaultNamespace = opts.namespace;
        this.namespace  = this.objs.defaultNamespace;
    }

    async path_for (apiVersion, kind) {
        /* XXX This is an undocumented ('protected') API. It fetches and
         * caches resource types. We could replace if needed. */
        const res = await this.objs.resource(apiVersion, kind);
        const apis = apiVersion.includes("/") ? "apis" : "api";
        const ens = encodeURIComponent(this.namespace);

        if (res.namespaced)
            return util.format("/%s/%s/namespaces/%s/%s",
                apis, apiVersion, ens, res.name);
        return util.format("/%s/%s/%s", apis, apiVersion, res.name);
    }

    /* Start a K8s watch and return a sequence of the results. */
    watch (path, query) {
        return new rx.Observable(obs => {
            /* watch returns a promise to a request, but this function
             * is not async. We don't need to await here; the callbacks
             * will get called when they are called. But when
             * unsubscription is requested we need to chain an abort
             * request onto the promise; usually (but not always) this
             * will execute immediately. */
            const reqp = this.watcher.watch(path, query,
                (type, obj) => obs.next([type, obj]), 
                err => err == null ? obs.complete() : obs.error(err));

            return () => reqp.then(req => req.abort());
        });
    }

    /* This returns a sequence consisting of
     *      CLEAR
     *      ADDED for all items in an initial fetch
     *      actions returned from a k8s watch
     * We do not make any k8s requests until the sequence is subscribed
     * to, and each subscription makes its own requests.
     */
    list_and_watch (opts) {
        /* Make the initial requests for each subscriber */
        return rx.defer(async () => {
            /* Get an initial list. */
            const list = await this.objs.list(
                opts.apiVersion, opts.kind, opts.namespace);

            /* Get the path to watch */
            const path = await this.path_for(opts.apiVersion, opts.kind);

            return [list.body, path];
        }).pipe(
            /* When the Promise resolves, produce a sequence by joining... */
            rx.mergeMap(([initial, path]) => rx.concat(
                /* An initial marker */
                rx.of(["CLEAR"]),
                /* The items from the initial fetch */
                rx.from(initial.items.map(i => ["ADDED", i])),
                /* A watch sequence which will start straight after the
                 * initial fetch. */
                this.watch(path,
                    { resourceVersion: initial.metadata.resourceVersion }),
            ))
        );
    }

    /* Returns a sequence of Immutable.Map representing the current
     * state of the objects of a particular kind. Key and value of the
     * map can be remapped, but default to the object UUID and the whole
     * object. Distinct updates will be suppressed, but the default
     * equality function (Immutable.is) will treat all plain JS objects
     * as distinct. */
    namespaced_kind (opts) {
        opts = {
            namespace:  this.namespace,
            key:        obj => obj.metadata.uid,
            value:      obj => obj,
            equal:      imm.is,
            ...opts,
        };

        /* Defer makes sure we do a new initial fetch every time we
         * retry the sequence */
        return this.list_and_watch(opts).pipe(
            rx.tap({ error: this.errors }),
            rx.retry({ delay: this.restart }),
            /* Pull out the key and value. CLEAR doesn't get mapped. */
            rx.map(([act, obj]) => 
                act == "CLEAR" ? [act]
                : [act, opts.key(obj), opts.value(obj)]),
            /* Accumulate the current state */
            rx.scan(
                (nodes, [act, key, value]) => 
                    act == "CLEAR" ? new imm.Map()
                    : act == "DELETED" ? nodes.delete(key)
                    : nodes.set(key, value),
                new imm.Map()),
            /* The mapping may remove changes */
            rx.distinctUntilChanged(opts.equal),
            /* Let the state settle */
            rx.debounceTime(this.debounce),
        );
    }
}
