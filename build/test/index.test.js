"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
const api_1 = require("@opentelemetry/api");
const context_async_hooks_1 = require("@opentelemetry/context-async-hooks");
const sdk_trace_base_1 = require("@opentelemetry/sdk-trace-base");
const assert = require("assert");
const util_1 = require("util");
const src_1 = require("../src");
const sinon = require("sinon");
const definitions_1 = require("./definitions");
const supportsPromises = parseInt(process.versions.node.split('.')[0], 10) > 8;
const TEST_ATTRIBUTE = 'test.attr';
const TEST_VALUE = 'test.attr.value';
const createHook = sinon.spy((fnName, { args, span }) => {
    // `ts-node`, which we use via `ts-mocha` also patches module loading and creates
    // a lot of unrelated spans. Filter those out.
    if (['readFileSync', 'existsSync'].includes(fnName)) {
        const filename = args[0];
        if (!/test\/fixtures/.test(filename)) {
            return false;
        }
    }
    return true;
});
const endHook = sinon.spy((fnName, { args, span }) => {
    span.setAttribute(TEST_ATTRIBUTE, TEST_VALUE);
});
const pluginConfig = {
    createHook,
    endHook,
};
const provider = new sdk_trace_base_1.BasicTracerProvider();
const tracer = provider.getTracer('default');
const memoryExporter = new sdk_trace_base_1.InMemorySpanExporter();
provider.addSpanProcessor(new sdk_trace_base_1.SimpleSpanProcessor(memoryExporter));
describe('fs instrumentation', () => {
    let contextManager;
    let fs;
    let plugin;
    beforeEach(async () => {
        contextManager = new context_async_hooks_1.AsyncHooksContextManager();
        api_1.context.setGlobalContextManager(contextManager.enable());
        plugin = new src_1.default(pluginConfig);
        plugin.setTracerProvider(provider);
        plugin.enable();
        fs = require('fs');
        Object.defineProperty(fs.promises, 'exists', {
            value: (...args) => {
                return Reflect.apply(util_1.promisify(fs.exists), fs, args);
            },
            configurable: true,
        });
        assert.strictEqual(memoryExporter.getFinishedSpans().length, 0);
    });
    afterEach(() => {
        delete fs.promises['exists'];
        plugin.disable();
        memoryExporter.reset();
        api_1.context.disable();
    });
    const syncTest = (name, args, { error, result, resultAsError = null }, spans) => {
        const syncName = `${name}Sync`;
        const rootSpanName = `${syncName} test span`;
        it(`${syncName} ${error ? 'error' : 'success'}`, () => {
            const rootSpan = tracer.startSpan(rootSpanName);
            assert.strictEqual(memoryExporter.getFinishedSpans().length, 0);
            api_1.context.with(api_1.trace.setSpan(api_1.context.active(), rootSpan), () => {
                if (error) {
                    assert.throws(() => Reflect.apply(fs[syncName], fs, args), error);
                }
                else {
                    assert.deepEqual(Reflect.apply(fs[syncName], fs, args), result !== null && result !== void 0 ? result : resultAsError);
                }
            });
            rootSpan.end();
            assertSpans(memoryExporter.getFinishedSpans(), [
                ...spans.map((s) => {
                    var _a;
                    const spanName = s.name.replace(/%NAME/, syncName);
                    const attributes = Object.assign({}, ((_a = s.attributes) !== null && _a !== void 0 ? _a : {}));
                    attributes[TEST_ATTRIBUTE] = TEST_VALUE;
                    return Object.assign(Object.assign({}, s), { name: spanName, attributes });
                }),
                { name: rootSpanName },
            ]);
        });
    };
    const callbackTest = (name, args, { error, result, resultAsError = null }, spans) => {
        const rootSpanName = `${name} test span`;
        it(`${name} ${error ? 'error' : 'success'}`, done => {
            const rootSpan = tracer.startSpan(rootSpanName);
            assert.strictEqual(memoryExporter.getFinishedSpans().length, 0);
            api_1.context.with(api_1.trace.setSpan(api_1.context.active(), rootSpan), () => {
                fs[name](...args, (actualError, actualResult) => {
                    var _a;
                    assert.strictEqual(api_1.trace.getSpan(api_1.context.active()), rootSpan);
                    try {
                        rootSpan.end();
                        if (error) {
                            assert(error.test((_a = actualError === null || actualError === void 0 ? void 0 : actualError.message) !== null && _a !== void 0 ? _a : ''), `Expected ${actualError === null || actualError === void 0 ? void 0 : actualError.message} to match ${error}`);
                        }
                        else {
                            if (actualError !== undefined) {
                                // this usually would mean that there is an error, but with `exists` function
                                // returns the result as the error, check whether we expect that behavior
                                // and if not, error the test
                                if (resultAsError === undefined) {
                                    if (actualError instanceof Error) {
                                        return done(actualError);
                                    }
                                    else {
                                        return done(new Error(`Expected callback to be called without an error got: ${actualError}`));
                                    }
                                }
                            }
                            assert.deepEqual(actualError, resultAsError);
                            assert.deepEqual(actualResult, result);
                        }
                        assertSpans(memoryExporter.getFinishedSpans(), [
                            ...spans.map((s) => {
                                var _a;
                                const spanName = s.name.replace(/%NAME/, name);
                                const attributes = Object.assign({}, ((_a = s.attributes) !== null && _a !== void 0 ? _a : {}));
                                attributes[TEST_ATTRIBUTE] = TEST_VALUE;
                                return Object.assign(Object.assign({}, s), { name: spanName, attributes });
                            }),
                            { name: rootSpanName },
                        ]);
                        done();
                    }
                    catch (e) {
                        done(e);
                    }
                });
            });
        });
    };
    const promiseTest = (name, args, { error, result, resultAsError = null }, spans) => {
        const rootSpanName = `${name} test span`;
        it(`promises.${name} ${error ? 'error' : 'success'}`, async () => {
            const rootSpan = tracer.startSpan(rootSpanName);
            assert.strictEqual(memoryExporter.getFinishedSpans().length, 0);
            await api_1.context
                .with(api_1.trace.setSpan(api_1.context.active(), rootSpan), () => {
                // eslint-disable-next-line node/no-unsupported-features/node-builtins
                assert(typeof fs.promises[name] === 'function', `Expected fs.promises.${name} to be a function`);
                return Reflect.apply(fs.promises[name], fs.promises, args);
            })
                .then((actualResult) => {
                if (error) {
                    assert.fail(`promises.${name} did not reject`);
                }
                else {
                    assert.deepEqual(actualResult, result !== null && result !== void 0 ? result : resultAsError);
                }
            })
                .catch((actualError) => {
                var _a;
                assert(actualError instanceof Error, `Expected caugth error to be instance of Error. Got ${actualError}`);
                if (error) {
                    assert(error.test((_a = actualError === null || actualError === void 0 ? void 0 : actualError.message) !== null && _a !== void 0 ? _a : ''), `Expected "${actualError === null || actualError === void 0 ? void 0 : actualError.message}" to match ${error}`);
                }
                else {
                    actualError.message = `Did not expect promises.${name} to reject: ${actualError.message}`;
                    assert.fail(actualError);
                }
            });
            rootSpan.end();
            assertSpans(memoryExporter.getFinishedSpans(), [
                ...spans.map((s) => {
                    var _a;
                    const spanName = s.name.replace(/%NAME/, name);
                    const attributes = Object.assign({}, ((_a = s.attributes) !== null && _a !== void 0 ? _a : {}));
                    attributes[TEST_ATTRIBUTE] = TEST_VALUE;
                    return Object.assign(Object.assign({}, s), { name: spanName, attributes });
                }),
                { name: rootSpanName },
            ]);
        });
    };
    describe('Syncronous API', () => {
        const selection = definitions_1.default.filter(([, , , , options = {}]) => options.sync !== false);
        describe('Instrumentation enabled', () => {
            selection.forEach(([name, args, result, spans]) => {
                syncTest(name, args, result, spans);
            });
            it('should instrument mkdirSync calls', () => {
                fs.mkdirSync('./test/fixtures/mkdirSync');
                fs.rmdirSync('./test/fixtures/mkdirSync');
                assertSpans(memoryExporter.getFinishedSpans(), [
                    {
                        name: 'fs mkdirSync',
                        attributes: { [TEST_ATTRIBUTE]: TEST_VALUE },
                    },
                    {
                        name: 'fs rmdirSync',
                        attributes: { [TEST_ATTRIBUTE]: TEST_VALUE },
                    },
                ]);
            });
        });
        describe('Instrumentation disabled', () => {
            beforeEach(() => {
                plugin.disable();
            });
            selection.forEach(([name, args, result]) => {
                syncTest(name, args, result, []);
            });
        });
    });
    describe('Callback API', () => {
        const selection = definitions_1.default.filter(([, , , , options = {}]) => options.callback !== false);
        describe('Instrumentation enabled', () => {
            selection.forEach(([name, args, result, spans]) => {
                callbackTest(name, args, result, spans);
            });
            it('should not suppress tracing in callbacks', done => {
                const readFileCatchErrors = (cb) => {
                    fs.readFile('./test/fixtures/readtest', (err, result) => {
                        try {
                            if (err) {
                                return done(err);
                            }
                            cb(result);
                        }
                        catch (err) {
                            done(err);
                        }
                    });
                };
                readFileCatchErrors(() => {
                    readFileCatchErrors(() => {
                        assertSpans(memoryExporter.getFinishedSpans(), [
                            {
                                name: 'fs readFile',
                                attributes: { [TEST_ATTRIBUTE]: TEST_VALUE },
                            },
                            {
                                name: 'fs readFile',
                                attributes: { [TEST_ATTRIBUTE]: TEST_VALUE },
                            },
                        ]);
                        done();
                    });
                });
            });
        });
        describe('Instrumentation disabled', () => {
            beforeEach(() => {
                plugin.disable();
            });
            selection.forEach(([name, args, result]) => {
                callbackTest(name, args, result, []);
            });
        });
    });
    if (supportsPromises) {
        describe('Promise API', () => {
            const selection = definitions_1.default.filter(([, , , , options = {}]) => options.promise !== false);
            describe('Instrumentation enabled', () => {
                selection.forEach(([name, args, result, spans]) => {
                    promiseTest(name, args, result, spans);
                });
            });
            describe('Instrumentation disabled', () => {
                beforeEach(() => {
                    plugin.disable();
                });
                selection.forEach(([name, args, result]) => {
                    promiseTest(name, args, result, []);
                });
            });
        });
    }
});
const assertSpans = (spans, expected) => {
    assert.strictEqual(spans.length, expected.length, `Expected ${expected.length} spans, got ${spans.length}(${spans
        .map((s) => `"${s.name}"`)
        .join(', ')})`);
    spans.forEach((span, i) => {
        assertSpan(span, expected[i]);
    });
};
const assertSpan = (span, expected) => {
    assert(span);
    assert.strictEqual(span.name, expected.name);
    assert.strictEqual(span.kind, api_1.SpanKind.INTERNAL, 'Expected to be of INTERNAL kind');
    if (expected.parentSpan) {
        assert.strictEqual(span.parentSpanId, expected.parentSpan.spanContext().spanId);
    }
    if (expected.attributes) {
        assert.deepEqual(span.attributes, expected.attributes);
    }
    if (expected.error) {
        assert(expected.error.test(span.status.message), `Expected "${span.status.message}" to match ${expected.error}`);
        assert.strictEqual(span.status.code, api_1.SpanStatusCode.ERROR);
    }
    else {
        assert.strictEqual(span.status.code, api_1.SpanStatusCode.UNSET, 'Expected status to be unset');
        assert.strictEqual(span.status.message, undefined);
    }
};
//# sourceMappingURL=index.test.js.map