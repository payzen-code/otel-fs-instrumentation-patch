"use strict";
/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const api = require("@opentelemetry/api");
const core_1 = require("@opentelemetry/core");
const instrumentation_1 = require("@opentelemetry/instrumentation");
const version_1 = require("./version");
const constants_1 = require("./constants");
const util_1 = require("util");
const supportsPromises = parseInt(process.versions.node.split('.')[0], 10) > 8;
class FsInstrumentation extends instrumentation_1.InstrumentationBase {
    constructor(config) {
        super('@opentelemetry/instrumentation-fs', version_1.VERSION, config);
    }
    init() {
        return [
            new instrumentation_1.InstrumentationNodeModuleDefinition('fs', ['*'], (moduleExports) => {
                const fs = moduleExports.default
                    ? moduleExports.default
                    : moduleExports;
                this._diag.debug('Applying patch for fs');
                for (const fName of constants_1.SYNC_FUNCTIONS) {
                    if (instrumentation_1.isWrapped(fs[fName])) {
                        this._unwrap(fs, fName);
                    }
                    this._wrap(fs, fName, this._patchSyncFunction.bind(this, fName));
                }
                for (const fName of constants_1.CALLBACK_FUNCTIONS) {
                    if (instrumentation_1.isWrapped(fs[fName])) {
                        this._unwrap(fs, fName);
                    }
                    if (fName === 'exists') {
                        // handling separately because of the inconsistent cb style:
                        // `exists` doesn't have error as the first argument, but the result
                        this._wrap(fs, fName, this._patchExistsCallbackFunction.bind(this, fName));
                        continue;
                    }
                    this._wrap(fs, fName, this._patchCallbackFunction.bind(this, fName));
                }
                if (supportsPromises) {
                    for (const fName of constants_1.PROMISE_FUNCTIONS) {
                        if (instrumentation_1.isWrapped(fs.promises[fName])) {
                            this._unwrap(fs.promises, fName);
                        }
                        this._wrap(fs.promises, fName, this._patchPromiseFunction.bind(this, fName));
                    }
                }
                return fs;
            }, (moduleExports) => {
                if (moduleExports === undefined)
                    return;
                const fs = moduleExports.default
                    ? moduleExports.default
                    : moduleExports;
                this._diag.debug('Removing patch for fs');
                for (const fName of constants_1.SYNC_FUNCTIONS) {
                    if (instrumentation_1.isWrapped(fs[fName])) {
                        this._unwrap(fs, fName);
                    }
                }
                for (const fName of constants_1.CALLBACK_FUNCTIONS) {
                    if (instrumentation_1.isWrapped(fs[fName])) {
                        this._unwrap(fs, fName);
                    }
                }
                if (supportsPromises) {
                    for (const fName of constants_1.PROMISE_FUNCTIONS) {
                        if (instrumentation_1.isWrapped(fs.promises[fName])) {
                            this._unwrap(fs.promises, fName);
                        }
                    }
                }
            }),
        ];
    }
    _patchSyncFunction(functionName, original) {
        const instrumentation = this;
        return function (...args) {
            if (core_1.isTracingSuppressed(api.context.active())) {
                // Performance optimization. Avoid creating additional contexts and spans
                // if we already know that the tracing is being suppressed.
                return original.apply(this, args);
            }
            if (instrumentation._runCreateHook(functionName, {
                args: args,
            }) === false) {
                return api.context.with(core_1.suppressTracing(api.context.active()), original, this, ...args);
            }
            const span = instrumentation.tracer.startSpan(`fs ${functionName}`);
            try {
                // Suppress tracing for internal fs calls
                const res = api.context.with(core_1.suppressTracing(api.trace.setSpan(api.context.active(), span)), original, this, ...args);
                instrumentation._runEndHook(functionName, { args: args, span });
                return res;
            }
            catch (error) {
                span.recordException(error);
                span.setStatus({
                    message: error.message,
                    code: api.SpanStatusCode.ERROR,
                });
                instrumentation._runEndHook(functionName, { args: args, span, error });
                throw error;
            }
            finally {
                span.end();
            }
        };
    }
    _patchCallbackFunction(functionName, original) {
        const instrumentation = this;
        return function (...args) {
            if (core_1.isTracingSuppressed(api.context.active())) {
                // Performance optimization. Avoid creating additional contexts and spans
                // if we already know that the tracing is being suppressed.
                return original.apply(this, args);
            }
            if (instrumentation._runCreateHook(functionName, {
                args: args,
            }) === false) {
                return api.context.with(core_1.suppressTracing(api.context.active()), original, this, ...args);
            }
            const lastIdx = args.length - 1;
            const cb = args[lastIdx];
            if (typeof cb === 'function') {
                const span = instrumentation.tracer.startSpan(`fs ${functionName}`);
                // Return to the context active during the call in the callback
                args[lastIdx] = api.context.bind(api.context.active(), function (error) {
                    if (error) {
                        span.recordException(error);
                        span.setStatus({
                            message: error.message,
                            code: api.SpanStatusCode.ERROR,
                        });
                    }
                    instrumentation._runEndHook(functionName, {
                        args: args,
                        span,
                        error,
                    });
                    span.end();
                    return cb.apply(this, arguments);
                });
                try {
                    // Suppress tracing for internal fs calls
                    return api.context.with(core_1.suppressTracing(api.trace.setSpan(api.context.active(), span)), original, this, ...args);
                }
                catch (error) {
                    span.recordException(error);
                    span.setStatus({
                        message: error.message,
                        code: api.SpanStatusCode.ERROR,
                    });
                    instrumentation._runEndHook(functionName, {
                        args: args,
                        span,
                        error,
                    });
                    span.end();
                    throw error;
                }
            }
            else {
                // TODO: what to do if we are pretty sure it's going to throw
                return original.apply(this, args);
            }
        };
    }
    _patchExistsCallbackFunction(functionName, original) {
        const instrumentation = this;
        const patchedFunction = function (...args) {
            if (core_1.isTracingSuppressed(api.context.active())) {
                // Performance optimization. Avoid creating additional contexts and spans
                // if we already know that the tracing is being suppressed.
                return original.apply(this, args);
            }
            if (instrumentation._runCreateHook(functionName, {
                args: args,
            }) === false) {
                return api.context.with(core_1.suppressTracing(api.context.active()), original, this, ...args);
            }
            const lastIdx = args.length - 1;
            const cb = args[lastIdx];
            if (typeof cb === 'function') {
                const span = instrumentation.tracer.startSpan(`fs ${functionName}`);
                // Return to the context active during the call in the callback
                args[lastIdx] = api.context.bind(api.context.active(), function () {
                    // `exists` never calls the callback with an error
                    instrumentation._runEndHook(functionName, {
                        args: args,
                        span,
                    });
                    span.end();
                    return cb.apply(this, arguments);
                });
                try {
                    // Suppress tracing for internal fs calls
                    return api.context.with(core_1.suppressTracing(api.trace.setSpan(api.context.active(), span)), original, this, ...args);
                }
                catch (error) {
                    span.recordException(error);
                    span.setStatus({
                        message: error.message,
                        code: api.SpanStatusCode.ERROR,
                    });
                    instrumentation._runEndHook(functionName, {
                        args: args,
                        span,
                        error,
                    });
                    span.end();
                    throw error;
                }
            }
            else {
                return original.apply(this, args);
            }
        };
        // `exists` has a custom promisify function because of the inconsistent signature
        // replicating that on the patched function
        const promisified = function (path) {
            return new Promise(resolve => patchedFunction(path, resolve));
        };
        Object.defineProperty(promisified, 'name', { value: functionName });
        Object.defineProperty(patchedFunction, util_1.promisify.custom, {
            value: promisified,
        });
        return patchedFunction;
    }
    _patchPromiseFunction(functionName, original) {
        const instrumentation = this;
        return async function (...args) {
            if (core_1.isTracingSuppressed(api.context.active())) {
                // Performance optimization. Avoid creating additional contexts and spans
                // if we already know that the tracing is being suppressed.
                return original.apply(this, args);
            }
            if (instrumentation._runCreateHook(functionName, {
                args: args,
            }) === false) {
                return api.context.with(core_1.suppressTracing(api.context.active()), original, this, ...args);
            }
            const span = instrumentation.tracer.startSpan(`fs ${functionName}`);
            try {
                // Suppress tracing for internal fs calls
                const res = await api.context.with(core_1.suppressTracing(api.trace.setSpan(api.context.active(), span)), original, this, ...args);
                instrumentation._runEndHook(functionName, { args: args, span });
                return res;
            }
            catch (error) {
                span.recordException(error);
                span.setStatus({
                    message: error.message,
                    code: api.SpanStatusCode.ERROR,
                });
                instrumentation._runEndHook(functionName, { args: args, span, error });
                throw error;
            }
            finally {
                span.end();
            }
        };
    }
    _runCreateHook(...args) {
        const { createHook } = this.getConfig();
        if (typeof createHook === 'function') {
            try {
                return createHook(...args);
            }
            catch (e) {
                this._diag.error('caught createHook error', e);
            }
        }
        return true;
    }
    _runEndHook(...args) {
        const { endHook } = this.getConfig();
        if (typeof endHook === 'function') {
            try {
                endHook(...args);
            }
            catch (e) {
                this._diag.error('caught endHook error', e);
            }
        }
    }
}
exports.default = FsInstrumentation;
//# sourceMappingURL=instrumentation.js.map