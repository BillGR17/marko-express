/*
GOAL: This module should mirror the NodeJS module system according the documented behavior.
The module transport will send down code that registers module definitions by an assigned path. In addition,
the module transport will send down code that registers additional metadata to allow the module resolver to
resolve modules in the browser. Additional metadata includes the following:

- "mains": The mapping of module directory paths to a fully resolved module path
- "remaps": The remapping of one fully resolved module path to another fully resolved module path (used for browser overrides)
- "run": A list of entry point modules that should be executed when ready

Inspired by:
https://github.com/joyent/node/blob/master/lib/module.js
*/
(function() {
    var win;

    if (typeof window !== 'undefined') {
        win = window;

        // This lasso modules client has already been loaded on the page. Do nothing;
        if (win.$_mod) {
            return;
        }

        win.global = win;
    }

    /** the module runtime */
    var $_mod;

    // this object stores the module factories with the keys being module paths and
    // values being a factory function or object (e.g. "/baz$3.0.0/lib/index" --> Function)
    var definitions = {};

    // Search path that will be checked when looking for modules
    var searchPaths = [];

    // The _ready flag is used to determine if "run" modules can
    // be executed or if they should be deferred until all dependencies
    // have been loaded
    var _ready = false;

    // If $_mod.run() is called when the page is not ready then
    // we queue up the run modules to be executed later
    var runQueue = [];

    // this object stores the Module instance cache with the keys being paths of modules (e.g., "/foo$1.0.0/bar" --> Module)
    var instanceCache = {};

    // This object maps installed dependencies to specific versions
    //
    // For example:
    // {
    //   // The package "foo" with version 1.0.0 has an installed package named "bar" (foo/node_modules/bar") and
    //   // the version of "bar" is 3.0.0
    //   "/foo$1.0.0/bar": "3.0.0"
    // }
    var installed = {};

    // Maps builtin modules such as "path", "buffer" to their fully resolved paths
    var builtins = {};

    // this object maps a directory to the fully resolved module path
    //
    // For example:
    //
    var mains = {};

    // used to remap a one fully resolved module path to another fully resolved module path
    var remapped = {};

    var cacheByDirname = {};

    // When a module is mapped to a global varialble we add a reference
    // that maps the path of the module to the loaded global instance.
    // We use this mapping to ensure that global modules are only loaded
    // once if they map to the same path.
    //
    // See issue #5 - Ensure modules mapped to globals only load once
    // https://github.com/raptorjs/raptor-modules/issues/5
    var loadedGlobalsByRealPath = {};

    function moduleNotFoundError(target, from) {
        var err = new Error('Cannot find module "' + target + '"' + (from ? ' from "' + from + '"' : ''));

        err.code = 'MODULE_NOT_FOUND';
        return err;
    }

    function Module(filename) {
       /*
        A Node module has these properties:
        - filename: The path of the module
        - id: The path of the module (same as filename)
        - exports: The exports provided during load
        - loaded: Has module been fully loaded (set to false until factory function returns)

        NOT SUPPORTED:
        - parent: parent Module
        - paths: The search path used by this module (NOTE: not documented in Node.js module system so we don't need support)
        - children: The modules that were required by this module
        */
        this.id = this.filename = filename;
        this.loaded = false;
        this.exports = undefined;
    }

    Module.cache = instanceCache;

    // temporary variable for referencing the Module prototype
    var Module_prototype = Module.prototype;

    Module_prototype.load = function(factoryOrObject) {
        var filename = this.id;

        if (factoryOrObject && factoryOrObject.constructor === Function) {
            // factoryOrObject is definitely a function
            var lastSlashPos = filename.lastIndexOf('/');

            // find the value for the __dirname parameter to factory
            var dirname = filename.substring(0, lastSlashPos);

            // local cache for requires initiated from this module/dirname
            var localCache = cacheByDirname[dirname] || (cacheByDirname[dirname] = {});

            // this is the require used by the module
            var instanceRequire = function(target) {
                // Only store the `module` in the local cache since `module.exports` may not be accurate
                // if there was a circular dependency
                var module = localCache[target] || (localCache[target] = requireModule(target, dirname));
                return module.exports;
            };

            // The require method should have a resolve method that will return the resolved
            // path but not actually instantiate the module.
            // This resolve function will make sure a definition exists for the corresponding
            // path of the target but it will not instantiate a new instance of the target.
            instanceRequire.resolve = function(target) {
                if (!target) {
                    throw moduleNotFoundError('');
                }

                var resolved = resolve(target, dirname);

                if (!resolved) {
                    throw moduleNotFoundError(target, dirname);
                }

                // NOTE: resolved[0] is the path and resolved[1] is the module factory
                return resolved[0];
            };

            // NodeJS provides access to the cache as a property of the "require" function
            instanceRequire.cache = instanceCache;

            // Expose the module system runtime via the `runtime` property
            // TODO: We should deprecate this in favor of `Module.prototype.__runtime`
            // @deprecated
            instanceRequire.runtime = $_mod;

            // $_mod.def("/foo$1.0.0/lib/index", function(require, exports, module, __filename, __dirname) {
            this.exports = {};

            // call the factory function
            factoryOrObject.call(this, instanceRequire, this.exports, this, filename, dirname);
        } else {
            // factoryOrObject is not a function so have exports reference factoryOrObject
            this.exports = factoryOrObject;
        }

        this.loaded = true;
    };

    /**
     * Defines a packages whose metadata is used by raptor-loader to load the package.
     */
    function define(path, factoryOrObject, options) {
        /*
        $_mod.def('/baz$3.0.0/lib/index', function(require, exports, module, __filename, __dirname) {
            // module source code goes here
        });
        */

        var globals = options && options.globals;

        definitions[path] = factoryOrObject;

        if (globals) {
            var target = win || global;
            for (var i=0;i<globals.length; i++) {
                var globalVarName = globals[i];
                var globalModule = loadedGlobalsByRealPath[path] = requireModule(path);
                target[globalVarName] = globalModule.exports;
            }
        }
    }

    function registerMain(path, relativePath) {
        mains[path] = relativePath;
    }

    function remap(fromPath, toPath) {
        remapped[fromPath] = toPath;
    }

    function builtin(name, target) {
        builtins[name] = target;
    }

    function registerInstalledDependency(parentPath, packageName, packageVersion) {
        // Example:
        // dependencies['/my-package$1.0.0/$/my-installed-package'] = '2.0.0'
        installed[parentPath + '/' + packageName] =  packageVersion;
    }

    /**
     * This function will take an array of path parts and normalize them by handling handle ".." and "."
     * and then joining the resultant string.
     *
     * @param {Array} parts an array of parts that presumedly was split on the "/" character.
     */
    function normalizePathParts(parts) {

        // IMPORTANT: It is assumed that parts[0] === "" because this method is used to
        // join an absolute path to a relative path
        var i;
        var len = 0;

        var numParts = parts.length;

        for (i = 0; i < numParts; i++) {
            var part = parts[i];

            if (part === '.') {
                // ignore parts with just "."
                /*
                // if the "." is at end of parts (e.g. ["a", "b", "."]) then trim it off
                if (i === numParts - 1) {
                    //len--;
                }
                */
            } else if (part === '..') {
                // overwrite the previous item by decrementing length
                len--;
            } else {
                // add this part to result and increment length
                parts[len] = part;
                len++;
            }
        }

        if (len === 1) {
            // if we end up with just one part that is empty string
            // (which can happen if input is ["", "."]) then return
            // string with just the leading slash
            return '/';
        } else if (len > 2) {
            // parts i s
            // ["", "a", ""]
            // ["", "a", "b", ""]
            if (parts[len - 1].length === 0) {
                // last part is an empty string which would result in trailing slash
                len--;
            }
        }

        // truncate parts to remove unused
        parts.length = len;
        return parts.join('/');
    }

    function join(from, target) {
        var targetParts = target.split('/');
        var fromParts = from == '/' ? [''] : from.split('/');
        return normalizePathParts(fromParts.concat(targetParts));
    }

    function withoutExtension(path) {
        var lastDotPos = path.lastIndexOf('.');
        var lastSlashPos;

        /* jshint laxbreak:true */
        return ((lastDotPos === -1) || ((lastSlashPos = path.lastIndexOf('/')) !== -1) && (lastSlashPos > lastDotPos))
            ? null // use null to indicate that returned path is same as given path
            : path.substring(0, lastDotPos);
    }

    function splitPackageIdAndSubpath(path) {
        path = path.substring(1); /* Skip past the first slash */
        // Examples:
        //     '/my-package$1.0.0/foo/bar' --> ['my-package$1.0.0', '/foo/bar']
        //     '/my-package$1.0.0' --> ['my-package$1.0.0', '']
        //     '/my-package$1.0.0/' --> ['my-package$1.0.0', '/']
        //     '/@my-scoped-package/foo/$1.0.0/' --> ['@my-scoped-package/foo$1.0.0', '/']
        var slashPos = path.indexOf('/');

        if (path.charAt(1) === '@') {
            // path is something like "/@my-user-name/my-scoped-package/subpath"
            // For scoped packages, the package name is two parts. We need to skip
            // past the second slash to get the full package name
            slashPos = path.indexOf('/', slashPos+1);
        }

        var packageIdEnd = slashPos === -1 ? path.length : slashPos;

        return [
            path.substring(0, packageIdEnd), // Everything up to the slash
            path.substring(packageIdEnd) // Everything after the package ID
        ];
    }

    function resolveInstalledModule(target, from) {
        // Examples:
        // target='foo', from='/my-package$1.0.0/hello/world'

        if (target.charAt(target.length-1) === '/') {
            // This is a hack because I found require('util/') in the wild and
            // it did not work because of the trailing slash
            target = target.slice(0, -1);
        }

        // Check to see if the target module is a builtin module.
        // For example:
        // builtins['path'] = '/path-browserify$0.0.0/index'
        var builtinPath = builtins[target];
        if (builtinPath) {
            return builtinPath;
        }

        var fromParts = splitPackageIdAndSubpath(from);
        var fromPackageId = fromParts[0];


        var targetSlashPos = target.indexOf('/');
        var targetPackageName;
        var targetSubpath;

        if (targetSlashPos < 0) {
            targetPackageName = target;
            targetSubpath = '';
        } else {

            if (target.charAt(0) === '@') {
                // target is something like "@my-user-name/my-scoped-package/subpath"
                // For scoped packages, the package name is two parts. We need to skip
                // past the first slash to get the full package name
                targetSlashPos = target.indexOf('/', targetSlashPos + 1);
            }

            targetPackageName = target.substring(0, targetSlashPos);
            targetSubpath = target.substring(targetSlashPos);
        }

        var targetPackageVersion = installed[fromPackageId + '/' + targetPackageName];
        if (targetPackageVersion) {
            var resolvedPath = '/' + targetPackageName + '$' + targetPackageVersion;
            if (targetSubpath) {
                resolvedPath += targetSubpath;
            }
            return resolvedPath;
        }
    }

    function resolve(target, from) {
        var resolvedPath;

        if (target.charAt(0) === '.') {
            // turn relative path into absolute path
            resolvedPath = join(from, target);
        } else if (target.charAt(0) === '/') {
            // handle targets such as "/my/file" or "/$/foo/$/baz"
            resolvedPath = normalizePathParts(target.split('/'));
        } else {
            var len = searchPaths.length;
            for (var i = 0; i < len; i++) {
                // search path entries always end in "/";
                var candidate = searchPaths[i] + target;
                var resolved = resolve(candidate, from);
                if (resolved) {
                    return resolved;
                }
            }

            resolvedPath = resolveInstalledModule(target, from);
        }

        if (!resolvedPath) {
            return undefined;
        }

        // target is something like "/foo/baz"
        // There is no installed module in the path
        var relativePath;

        // check to see if "target" is a "directory" which has a registered main file
        if ((relativePath = mains[resolvedPath]) !== undefined) {
            if (!relativePath) {
                relativePath = 'index';
            }

            // there is a main file corresponding to the given target so add the relative path
            resolvedPath = join(resolvedPath, relativePath);
        }

        var remappedPath = remapped[resolvedPath];
        if (remappedPath) {
            resolvedPath = remappedPath;
        }

        var factoryOrObject = definitions[resolvedPath];
        if (factoryOrObject === undefined) {
            // check for definition for given path but without extension
            var resolvedPathWithoutExtension;
            if (((resolvedPathWithoutExtension = withoutExtension(resolvedPath)) === null) ||
                ((factoryOrObject = definitions[resolvedPathWithoutExtension]) === undefined)) {
                return undefined;
            }

            // we found the definition based on the path without extension so
            // update the path
            resolvedPath = resolvedPathWithoutExtension;
        }

        return [resolvedPath, factoryOrObject];
    }

    function requireModule(target, from) {
        if (!target) {
            throw moduleNotFoundError('');
        }

        var resolved = resolve(target, from);
        if (!resolved) {
            throw moduleNotFoundError(target, from);
        }

        var resolvedPath = resolved[0];

        var module = instanceCache[resolvedPath];

        if (module !== undefined) {
            // found cached entry based on the path
            return module;
        }

        // Fixes issue #5 - Ensure modules mapped to globals only load once
        // https://github.com/raptorjs/raptor-modules/issues/5
        //
        // If a module is mapped to a global variable then we want to always
        // return that global instance of the module when it is being required
        // to avoid duplicate modules being loaded. For modules that are mapped
        // to global variables we also add an entry that maps the path
        // of the module to the global instance of the loaded module.

        if (loadedGlobalsByRealPath.hasOwnProperty(resolvedPath)) {
            return loadedGlobalsByRealPath[resolvedPath];
        }

        var factoryOrObject = resolved[1];

        module = new Module(resolvedPath);

        // cache the instance before loading (allows support for circular dependency with partial loading)
        instanceCache[resolvedPath] = module;

        module.load(factoryOrObject);

        return module;
    }

    function require(target, from) {
        var module = requireModule(target, from);
        return module.exports;
    }

    /*
    $_mod.run('/$/installed-module', '/src/foo');
    */
    function run(path, options) {
        var wait = !options || (options.wait !== false);
        if (wait && !_ready) {
            return runQueue.push([path, options]);
        }

        require(path, '/');
    }

    /*
     * Mark the page as being ready and execute any of the
     * run modules that were deferred
     */
    function ready() {
        _ready = true;

        var len;
        while((len = runQueue.length)) {
            // store a reference to the queue before we reset it
            var queue = runQueue;

            // clear out the queue
            runQueue = [];

            // run all of the current jobs
            for (var i = 0; i < len; i++) {
                var args = queue[i];
                run(args[0], args[1]);
            }

            // stop running jobs in the queue if we change to not ready
            if (!_ready) {
                break;
            }
        }
    }

    function addSearchPath(prefix) {
        searchPaths.push(prefix);
    }

    var pendingCount = 0;
    var onPendingComplete = function() {
        pendingCount--;
        if (!pendingCount) {
            // Trigger any "require-run" modules in the queue to run
            ready();
        }
    };

    /*
     * $_mod is the short-hand version that that the transport layer expects
     * to be in the browser window object
     */
    Module_prototype.__runtime = $_mod = {
        /**
         * Used to register a module factory/object (*internal*)
         */
        def: define,

        /**
         * Used to register an installed dependency (e.g. "/$/foo" depends on "baz") (*internal*)
         */
        installed: registerInstalledDependency,
        run: run,
        main: registerMain,
        remap: remap,
        builtin: builtin,
        require: require,
        resolve: resolve,
        join: join,
        ready: ready,

        /**
         * Add a search path entry (internal)
         */
        searchPath: addSearchPath,

        /**
         * Sets the loader metadata for this build.
         *
         * @param asyncPackageName {String} name of asynchronous package
         * @param contentType {String} content type ("js" or "css")
         * @param bundleUrl {String} URL of bundle that belongs to package
         */
        loaderMetadata: function(data) {
            // We store loader metadata in the prototype of Module
            // so that `lasso-loader` can read it from
            // `module.__loaderMetadata`.
            Module_prototype.__loaderMetadata = data;
        },

        /**
         * Asynchronous bundle loaders should call `pending()` to instantiate
         * a new job. The object we return here has a `done` method that
         * should be called when the job completes. When the number of
         * pending jobs drops to 0, we invoke any of the require-run modules
         * that have been declared.
         */
        pending: function() {
            _ready = false;
            pendingCount++;
            return {
                done: onPendingComplete
            };
        }
    };

    if (win) {
        win.$_mod = $_mod;
    } else {
        module.exports = $_mod;
    }
})();

$_mod.installed("marko-express-starter$0.0.0", "marko", "4.5.3");
$_mod.main("/marko$4.5.3/src/runtime/vdom", "");
$_mod.main("/marko$4.5.3/src", "");
$_mod.remap("/marko$4.5.3/src/index", "/marko$4.5.3/src/index-browser");
$_mod.def("/marko$4.5.3/src/runtime/createOut", function(require, exports, module, __filename, __dirname) { var actualCreateOut;

function setCreateOut(createOutFunc) {
    actualCreateOut = createOutFunc;
}

function createOut(globalData) {
    return actualCreateOut(globalData);
}

createOut.___setCreateOut = setCreateOut;

module.exports = createOut;
});
$_mod.main("/marko$4.5.3/src/loader", "");
$_mod.remap("/marko$4.5.3/src/loader/index", "/marko$4.5.3/src/loader/index-browser");
$_mod.remap("/marko$4.5.3/src/loader/index-browser", "/marko$4.5.3/src/loader/index-browser-dynamic");
$_mod.def("/marko$4.5.3/src/loader/index-browser-dynamic", function(require, exports, module, __filename, __dirname) { 'use strict';
module.exports = function load(templatePath) {
    // We make the assumption that the template path is a
    // fully resolved module path and that the module exists
    // as a CommonJS module
    return require(templatePath);
};
});
$_mod.def("/marko$4.5.3/src/index-browser", function(require, exports, module, __filename, __dirname) { 'use strict';
exports.createOut = require('/marko$4.5.3/src/runtime/createOut'/*'./runtime/createOut'*/);
exports.load = require('/marko$4.5.3/src/loader/index-browser-dynamic'/*'./loader'*/);

});
$_mod.installed("marko$4.5.3", "events-light", "1.0.5");
$_mod.main("/events-light$1.0.5", "src/index");
$_mod.def("/events-light$1.0.5/src/index", function(require, exports, module, __filename, __dirname) { /* jshint newcap:false */
var slice = Array.prototype.slice;

function isFunction(arg) {
    return typeof arg === 'function';
}

function checkListener(listener) {
    if (!isFunction(listener)) {
        throw TypeError('Invalid listener');
    }
}

function invokeListener(ee, listener, args) {
    switch (args.length) {
        // fast cases
        case 1:
            listener.call(ee);
            break;
        case 2:
            listener.call(ee, args[1]);
            break;
        case 3:
            listener.call(ee, args[1], args[2]);
            break;
            // slower
        default:
            listener.apply(ee, slice.call(args, 1));
    }
}

function addListener(eventEmitter, type, listener, prepend) {
    checkListener(listener);

    var events = eventEmitter.$e || (eventEmitter.$e = {});

    var listeners = events[type];
    if (listeners) {
        if (isFunction(listeners)) {
            events[type] = prepend ? [listener, listeners] : [listeners, listener];
        } else {
            if (prepend) {
                listeners.unshift(listener);
            } else {
                listeners.push(listener);
            }
        }

    } else {
        events[type] = listener;
    }
    return eventEmitter;
}

function EventEmitter() {
    this.$e = this.$e || {};
}

EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype = {
    $e: null,

    emit: function(type) {
        var args = arguments;

        var events = this.$e;
        if (!events) {
            return;
        }

        var listeners = events && events[type];
        if (!listeners) {
            // If there is no 'error' event listener then throw.
            if (type === 'error') {
                var error = args[1];
                if (!(error instanceof Error)) {
                    var context = error;
                    error = new Error('Error: ' + context);
                    error.context = context;
                }

                throw error; // Unhandled 'error' event
            }

            return false;
        }

        if (isFunction(listeners)) {
            invokeListener(this, listeners, args);
        } else {
            listeners = slice.call(listeners);

            for (var i=0, len=listeners.length; i<len; i++) {
                var listener = listeners[i];
                invokeListener(this, listener, args);
            }
        }

        return true;
    },

    on: function(type, listener) {
        return addListener(this, type, listener, false);
    },

    prependListener: function(type, listener) {
        return addListener(this, type, listener, true);
    },

    once: function(type, listener) {
        checkListener(listener);

        function g() {
            this.removeListener(type, g);

            if (listener) {
                listener.apply(this, arguments);
                listener = null;
            }
        }

        this.on(type, g);

        return this;
    },

    // emits a 'removeListener' event iff the listener was removed
    removeListener: function(type, listener) {
        checkListener(listener);

        var events = this.$e;
        var listeners;

        if (events && (listeners = events[type])) {
            if (isFunction(listeners)) {
                if (listeners === listener) {
                    delete events[type];
                }
            } else {
                for (var i=listeners.length-1; i>=0; i--) {
                    if (listeners[i] === listener) {
                        listeners.splice(i, 1);
                    }
                }
            }
        }

        return this;
    },

    removeAllListeners: function(type) {
        var events = this.$e;
        if (events) {
            delete events[type];
        }
    },

    listenerCount: function(type) {
        var events = this.$e;
        var listeners = events && events[type];
        return listeners ? (isFunction(listeners) ? 1 : listeners.length) : 0;
    }
};

module.exports = EventEmitter;
});
$_mod.def("/marko$4.5.3/src/runtime/vdom/VNode", function(require, exports, module, __filename, __dirname) { /* jshint newcap:false */
function VNode() {}

VNode.prototype = {
    ___VNode: function(finalChildCount) {
        this.___finalChildCount = finalChildCount;
        this.___childCount = 0;
        this.___firstChildInternal = null;
        this.___lastChild = null;
        this.___parentNode = null;
        this.___nextSiblingInternal = null;
    },

    ___component: null,

    get ___firstChild() {
        var firstChild = this.___firstChildInternal;

        if (firstChild && firstChild.___DocumentFragment) {
            var nestedFirstChild = firstChild.___firstChild;
            // The first child is a DocumentFragment node.
            // If the DocumentFragment node has a first child then we will return that.
            // Otherwise, the DocumentFragment node is not *really* the first child and
            // we need to skip to its next sibling
            return nestedFirstChild || firstChild.___nextSibling;
        }

        return firstChild;
    },

    get ___nextSibling() {
        var nextSibling = this.___nextSiblingInternal;

        if (nextSibling) {
            if (nextSibling.___DocumentFragment) {
                var firstChild = nextSibling.___firstChild;
                return firstChild || nextSibling.___nextSibling;
            }
        } else {
            var parentNode = this.___parentNode;
            if (parentNode && parentNode.___DocumentFragment) {
                return parentNode.___nextSibling;
            }
        }

        return nextSibling;
    },

    ___appendChild: function(child) {
        this.___childCount++;

        if (this.___isTextArea === true) {
            if (child.___Text) {
                var childValue = child.___nodeValue;
                this.___valueInternal = (this.___valueInternal || '') + childValue;
            } else {
                throw TypeError();
            }
        } else {
            var lastChild = this.___lastChild;

            child.___parentNode = this;

            if (lastChild) {
                lastChild.___nextSiblingInternal = child;
            } else {
                this.___firstChildInternal = child;
            }

            this.___lastChild = child;
        }

        return child;
    },

    ___finishChild: function finishChild() {
        if (this.___childCount === this.___finalChildCount && this.___parentNode) {
            return this.___parentNode.___finishChild();
        } else {
            return this;
        }
    },


    // ,toJSON: function() {
    //     var clone = Object.assign({
    //         nodeType: this.nodeType
    //     }, this);
    //
    //     for (var k in clone) {
    //         if (k.startsWith('_')) {
    //             delete clone[k];
    //         }
    //     }
    //     delete clone._nextSibling;
    //     delete clone._lastChild;
    //     delete clone.parentNode;
    //     return clone;
    // }
};

module.exports = VNode;

});
$_mod.installed("marko$4.5.3", "raptor-util", "3.2.0");
$_mod.def("/raptor-util$3.2.0/copyProps", function(require, exports, module, __filename, __dirname) { module.exports = function copyProps(from, to) {
    Object.getOwnPropertyNames(from).forEach(function(name) {
        var descriptor = Object.getOwnPropertyDescriptor(from, name);
        Object.defineProperty(to, name, descriptor);
    });
};
});
$_mod.def("/raptor-util$3.2.0/inherit", function(require, exports, module, __filename, __dirname) { var copyProps = require('/raptor-util$3.2.0/copyProps'/*'./copyProps'*/);

function inherit(ctor, superCtor, shouldCopyProps) {
    var oldProto = ctor.prototype;
    var newProto = ctor.prototype = Object.create(superCtor.prototype, {
        constructor: {
            value: ctor,
            writable: true,
            configurable: true
        }
    });
    if (oldProto && shouldCopyProps !== false) {
        copyProps(oldProto, newProto);
    }
    ctor.$super = superCtor;
    ctor.prototype = newProto;
    return ctor;
}


module.exports = inherit;
inherit._inherit = inherit;

});
$_mod.def("/marko$4.5.3/src/runtime/vdom/VComment", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.5.3/src/runtime/vdom/VNode'/*'./VNode'*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*'raptor-util/inherit'*/);

function VComment(value) {
    this.___VNode(-1 /* no children */);
    this.___nodeValue = value;
}

VComment.prototype = {
    ___nodeType: 8,

    ___actualize: function(doc) {
        var nodeValue = this.___nodeValue;
        return doc.createComment(nodeValue);
    },

    ___cloneNode: function() {
        return new VComment(this.___nodeValue);
    }
};

inherit(VComment, VNode);

module.exports = VComment;

});
$_mod.def("/raptor-util$3.2.0/extend", function(require, exports, module, __filename, __dirname) { module.exports = function extend(target, source) { //A simple function to copy properties from one object to another
    if (!target) { //Check if a target was provided, otherwise create a new empty object to return
        target = {};
    }

    if (source) {
        for (var propName in source) {
            if (source.hasOwnProperty(propName)) { //Only look at source properties that are not inherited
                target[propName] = source[propName]; //Copy the property
            }
        }
    }

    return target;
};
});
$_mod.def("/marko$4.5.3/src/runtime/vdom/VDocumentFragment", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.5.3/src/runtime/vdom/VNode'/*'./VNode'*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*'raptor-util/inherit'*/);
var extend = require('/raptor-util$3.2.0/extend'/*'raptor-util/extend'*/);

function VDocumentFragmentClone(other) {
    extend(this, other);
    this.___parentNode = null;
    this.___nextSiblingInternal = null;
}

function VDocumentFragment(out) {
    this.___VNode(null /* childCount */);
    this.___out = out;
}

VDocumentFragment.prototype = {
    ___nodeType: 11,

    ___DocumentFragment: true,

    ___cloneNode: function() {
        return new VDocumentFragmentClone(this);
    },

    ___actualize: function(doc) {
        return doc.createDocumentFragment();
    }
};

inherit(VDocumentFragment, VNode);

VDocumentFragmentClone.prototype = VDocumentFragment.prototype;

module.exports = VDocumentFragment;

});
$_mod.def("/marko$4.5.3/src/runtime/vdom/VElement", function(require, exports, module, __filename, __dirname) { /* jshint newcap:false */
var VNode = require('/marko$4.5.3/src/runtime/vdom/VNode'/*'./VNode'*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*'raptor-util/inherit'*/);
var NS_XLINK = 'http://www.w3.org/1999/xlink';
var ATTR_XLINK_HREF = 'xlink:href';
var xmlnsRegExp = /^xmlns(:|$)/;

var toString = String;

var FLAG_IS_SVG = 1;
var FLAG_IS_TEXTAREA = 2;
var FLAG_SIMPLE_ATTRS = 4;
// var FLAG_PRESERVE = 8;
var FLAG_CUSTOM_ELEMENT = 16;

var defineProperty = Object.defineProperty;

var ATTR_HREF = 'href';
var EMPTY_OBJECT = Object.freeze({});

function convertAttrValue(type, value) {
    if (value === true) {
        return '';
    } else if (type == 'object') {
        return JSON.stringify(value);
    } else {
        return toString(value);
    }
}

function setAttribute(el, namespaceURI, name, value) {
    if (namespaceURI === null) {
        el.setAttribute(name, value);
    } else {
        el.setAttributeNS(namespaceURI, name, value);
    }
}

function removeAttribute(el, namespaceURI, name) {
    if (namespaceURI === null) {
        el.removeAttribute(name);
    } else {
        el.removeAttributeNS(namespaceURI, name);
    }
}

function VElementClone(other) {
    this.___firstChildInternal = other.___firstChildInternal;
    this.___parentNode = null;
    this.___nextSiblingInternal = null;

    this.___key = other.___key;
    this.___attributes = other.___attributes;
    this.___properties = other.___properties;
    this.___namespaceURI = other.___namespaceURI;
    this.___nodeName = other.___nodeName;
    this.___flags = other.___flags;
    this.___valueInternal = other.___valueInternal;
    this.___constId = other.___constId;
    this.___isTextArea = other.___isTextArea;
}

function VElement(tagName, attrs, key, component, childCount, flags, props) {
    this.___VNode(childCount);

    var constId;
    var namespaceURI;
    var isTextArea;

    if (props) {
        constId = props.i;
    }

    if ((this.___flags = flags || 0)) {
        if (flags & FLAG_IS_SVG) {
            namespaceURI = 'http://www.w3.org/2000/svg';
        }
        if (flags & FLAG_IS_TEXTAREA) {
            isTextArea = true;
        }
    }

    this.___key = key;
    this.___component = component;
    this.___attributes = attrs || EMPTY_OBJECT;
    this.___properties = props || EMPTY_OBJECT;
    this.___namespaceURI = namespaceURI;
    this.___nodeName = tagName;
    this.___valueInternal = null;
    this.___constId = constId;
    this.___isTextArea = isTextArea;
}

VElement.prototype = {
    ___nodeType: 1,

    ___cloneNode: function() {
        return new VElementClone(this);
    },

    /**
     * Shorthand method for creating and appending an HTML element
     *
     * @param  {String} tagName    The tag name (e.g. "div")
     * @param  {int|null} attrCount  The number of attributes (or `null` if not known)
     * @param  {int|null} childCount The number of child nodes (or `null` if not known)
     */
    e: function(tagName, attrs, key, component, childCount, flags, props) {
        var child = this.___appendChild(new VElement(tagName, attrs, key, component, childCount, flags, props));

        if (childCount === 0) {
            return this.___finishChild();
        } else {
            return child;
        }
    },

    /**
     * Shorthand method for creating and appending an HTML element with a dynamic namespace
     *
     * @param  {String} tagName    The tag name (e.g. "div")
     * @param  {int|null} attrCount  The number of attributes (or `null` if not known)
     * @param  {int|null} childCount The number of child nodes (or `null` if not known)
     */
    ed: function(tagName, attrs, key, component, childCount, flags, props) {
        var child = this.___appendChild(VElement.___createElementDynamicTag(tagName, attrs, key, component, childCount, flags, props));

        if (childCount === 0) {
            return this.___finishChild();
        } else {
            return child;
        }
    },

    /**
     * Shorthand method for creating and appending a static node. The provided node is automatically cloned
     * using a shallow clone since it will be mutated as a result of setting `nextSibling` and `parentNode`.
     *
     * @param  {String} value The value for the new Comment node
     */
    n: function(node, component) {
        node = node.___cloneNode();
        node.___component = component;
        this.___appendChild(node);
        return this.___finishChild();
    },

    ___actualize: function(doc) {
        var namespaceURI = this.___namespaceURI;
        var tagName = this.___nodeName;

        var attributes = this.___attributes;
        var flags = this.___flags;

        var el = namespaceURI !== undefined ?
            doc.createElementNS(namespaceURI, tagName) :
            doc.createElement(tagName);

        if (flags & FLAG_CUSTOM_ELEMENT) {
            Object.assign(el, attributes);
        } else {
            for (var attrName in attributes) {
                var attrValue = attributes[attrName];

                if (attrValue !== false && attrValue != null) {
                    var type = typeof attrValue;

                    if (type !== 'string') {
                        // Special attributes aren't copied to the real DOM. They are only
                        // kept in the virtual attributes map
                        attrValue = convertAttrValue(type, attrValue);
                    }

                    if (attrName == ATTR_XLINK_HREF) {
                        setAttribute(el, NS_XLINK, ATTR_HREF, attrValue);
                    } else {
                        el.setAttribute(attrName, attrValue);
                    }
                }
            }

            if (flags & FLAG_IS_TEXTAREA) {
                el.value = this.___value;
            }
        }

        el.___markoVElement = this;

        return el;
    },

    ___hasAttribute: function(name) {
        // We don't care about the namespaces since the there
        // is no chance that attributes with the same name will have
        // different namespaces
        var value = this.___attributes[name];
        return value != null && value !== false;
    }
};

inherit(VElement, VNode);

var proto = VElementClone.prototype = VElement.prototype;

['checked', 'selected', 'disabled'].forEach(function(name) {
    defineProperty(proto, name, {
        get: function () {
            var value = this.___attributes[name];
            return value !== false && value != null;
        }
    });
});

defineProperty(proto, '___value', {
    get: function () {
        var value = this.___valueInternal;
        if (value == null) {
            value = this.___attributes.value;
        }
        return value != null ? toString(value) : '';
    }
});

VElement.___createElementDynamicTag = function(tagName, attrs, key, component, childCount, flags, props) {
    var namespace = attrs && attrs.xmlns;
    tagName = namespace ? tagName : tagName.toUpperCase();
    var element = new VElement(tagName, attrs, key, component, childCount, flags, props);
    element.___namespaceURI = namespace;
    return element;
};

VElement.___removePreservedAttributes = function(attrs) {
    // By default this static method is a no-op, but if there are any
    // compiled components that have "no-update" attributes then
    // `preserve-attrs.js` will be imported and this method will be replaced
    // with a method that actually does something
    return attrs;
};

function virtualizeElement(node, virtualizeChildNodes) {
    var attributes = node.attributes;
    var attrCount = attributes.length;

    var attrs;

    if (attrCount) {
        attrs = {};
        for (var i=0; i<attrCount; i++) {
            var attr = attributes[i];
            var attrName = attr.name;
            if (!xmlnsRegExp.test(attrName) && attrName !== 'data-marko') {
                var attrNamespaceURI = attr.namespaceURI;
                if (attrNamespaceURI === NS_XLINK) {
                    attrs[ATTR_XLINK_HREF] = attr.value;
                } else {
                    attrs[attrName] = attr.value;
                }
            }
        }
    }

    var flags = 0;

    var tagName = node.nodeName;
    if (tagName === 'TEXTAREA') {
        flags |= FLAG_IS_TEXTAREA;
    }

    var vdomEl = new VElement(tagName, attrs, null /*key*/, null /*component*/, 0 /*child count*/, flags, null /*props*/);
    if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
        vdomEl.___namespaceURI = node.namespaceURI;
    }

    if (vdomEl.___isTextArea) {
        vdomEl.___valueInternal = node.value;
    } else {
        if (virtualizeChildNodes) {
            virtualizeChildNodes(node, vdomEl);
        }
    }

    return vdomEl;
}

VElement.___virtualize = virtualizeElement;

VElement.___morphAttrs = function(fromEl, vFromEl, toEl) {
    var removePreservedAttributes = VElement.___removePreservedAttributes;

    var fromFlags = vFromEl.___flags;
    var toFlags = toEl.___flags;

    fromEl.___markoVElement = toEl;

    var attrs = toEl.___attributes;
    var props = toEl.___properties;

    if (toFlags & FLAG_CUSTOM_ELEMENT) {
        return Object.assign(fromEl, attrs);
    }

    var attrName;

    // We use expando properties to associate the previous HTML
    // attributes provided as part of the VDOM node with the
    // real VElement DOM node. When diffing attributes,
    // we only use our internal representation of the attributes.
    // When diffing for the first time it's possible that the
    // real VElement node will not have the expando property
    // so we build the attribute map from the expando property

    var oldAttrs = vFromEl.___attributes;

    if (oldAttrs) {
        if (oldAttrs === attrs) {
            // For constant attributes the same object will be provided
            // every render and we can use that to our advantage to
            // not waste time diffing a constant, immutable attribute
            // map.
            return;
        } else {
            oldAttrs = removePreservedAttributes(oldAttrs, props);
        }
    }

    var attrValue;

    if (toFlags & FLAG_SIMPLE_ATTRS && fromFlags & FLAG_SIMPLE_ATTRS) {
        if (oldAttrs['class'] !== (attrValue = attrs['class'])) {
            fromEl.className = attrValue;
        }
        if (oldAttrs.id !== (attrValue = attrs.id)) {
            fromEl.id = attrValue;
        }
        if (oldAttrs.style !== (attrValue = attrs.style)) {
            fromEl.style.cssText = attrValue;
        }
        return;
    }


    // In some cases we only want to set an attribute value for the first
    // render or we don't want certain attributes to be touched. To support
    // that use case we delete out all of the preserved attributes
    // so it's as if they never existed.
    attrs = removePreservedAttributes(attrs, props, true);

    var namespaceURI;

    // Loop over all of the attributes in the attribute map and compare
    // them to the value in the old map. However, if the value is
    // null/undefined/false then we want to remove the attribute
    for (attrName in attrs) {
        attrValue = attrs[attrName];
        namespaceURI = null;

        if (attrName === ATTR_XLINK_HREF) {
            namespaceURI = NS_XLINK;
            attrName = ATTR_HREF;
        }

        if (attrValue == null || attrValue === false) {
            removeAttribute(fromEl, namespaceURI, attrName);
        } else if (oldAttrs[attrName] !== attrValue) {
            var type = typeof attrValue;

            if (type !== 'string') {
                attrValue = convertAttrValue(type, attrValue);
            }

            setAttribute(fromEl, namespaceURI, attrName, attrValue);
        }
    }

    // If there are any old attributes that are not in the new set of attributes
    // then we need to remove those attributes from the target node
    //
    // NOTE: We can skip this if the the element is keyed because if the element
    //       is keyed then we know we already processed all of the attributes for
    //       both the target and original element since target VElement nodes will
    //       have all attributes declared. However, we can only skip if the node
    //       was not a virtualized node (i.e., a node that was not rendered by a
    //       Marko template, but rather a node that was created from an HTML
    //       string or a real DOM node).
    if (toEl.___key === null) {
        for (attrName in oldAttrs) {
            if (!(attrName in attrs)) {
                if (attrName === ATTR_XLINK_HREF) {
                    fromEl.removeAttributeNS(ATTR_XLINK_HREF, ATTR_HREF);
                } else {
                    fromEl.removeAttribute(attrName);
                }
            }
        }
    }
};

module.exports = VElement;

});
$_mod.def("/marko$4.5.3/src/runtime/vdom/VText", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.5.3/src/runtime/vdom/VNode'/*'./VNode'*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*'raptor-util/inherit'*/);

function VText(value) {
    this.___VNode(-1 /* no children */);
    this.___nodeValue = value;
}

VText.prototype = {
    ___Text: true,

    ___nodeType: 3,

    ___actualize: function(doc) {
        return doc.createTextNode(this.___nodeValue);
    },

    ___cloneNode: function() {
        return new VText(this.___nodeValue);
    }
};

inherit(VText, VNode);

module.exports = VText;

});
$_mod.def("/marko$4.5.3/src/runtime/vdom/VComponent", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.5.3/src/runtime/vdom/VNode'/*'./VNode'*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*'raptor-util/inherit'*/);

function VComponent(component, preserve) {
    this.___VNode(null /* childCount */);
    this.___component = component;
    this.___preserve = preserve;
}

VComponent.prototype = {
    ___nodeType: 2
};

inherit(VComponent, VNode);

module.exports = VComponent;

});
$_mod.def("/marko$4.5.3/src/runtime/vdom/vdom", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.5.3/src/runtime/vdom/VNode'/*'./VNode'*/);
var VComment = require('/marko$4.5.3/src/runtime/vdom/VComment'/*'./VComment'*/);
var VDocumentFragment = require('/marko$4.5.3/src/runtime/vdom/VDocumentFragment'/*'./VDocumentFragment'*/);
var VElement = require('/marko$4.5.3/src/runtime/vdom/VElement'/*'./VElement'*/);
var VText = require('/marko$4.5.3/src/runtime/vdom/VText'/*'./VText'*/);
var VComponent = require('/marko$4.5.3/src/runtime/vdom/VComponent'/*'./VComponent'*/);

var defaultDocument = typeof document != 'undefined' && document;
var specialHtmlRegexp = /[&<]/;


function virtualizeChildNodes(node, vdomParent) {
    var curChild = node.firstChild;
    while(curChild) {
        vdomParent.___appendChild(virtualize(curChild));
        curChild = curChild.nextSibling;
    }
}

function virtualize(node, shallow) {
    switch(node.nodeType) {
        case 1:
            return VElement.___virtualize(node, virtualizeChildNodes);
        case 3:
            return new VText(node.nodeValue);
        case 8:
            return new VComment(node.nodeValue);
        case 11:
            var vdomDocFragment = new VDocumentFragment();
            virtualizeChildNodes(node, vdomDocFragment);
            return vdomDocFragment;
    }
}

function virtualizeHTML(html, doc) {
    if (!specialHtmlRegexp.test(html)) {
        return new VText(html);
    }

    var container = doc.createElement('body');
    container.innerHTML = html;
    var vdomFragment = new VDocumentFragment();

    var curChild = container.firstChild;
    while(curChild) {
        vdomFragment.___appendChild(virtualize(curChild));
        curChild = curChild.nextSibling;
    }

    return vdomFragment;
}

var Node_prototype = VNode.prototype;

/**
 * Shorthand method for creating and appending a Text node with a given value
 * @param  {String} value The text value for the new Text node
 */
Node_prototype.t = function(value) {
    var type = typeof value;
    var vdomNode;

    if (type !== 'string') {
        if (value == null) {
            value = '';
        } else if (type === 'object') {
            if (value.toHTML) {
                vdomNode = virtualizeHTML(value.toHTML(), document);
            }
        }
    }

    this.___appendChild(vdomNode || new VText(value.toString()));
    return this.___finishChild();
};

/**
 * Shorthand method for creating and appending a Comment node with a given value
 * @param  {String} value The value for the new Comment node
 */
Node_prototype.c = function(value) {
    this.___appendChild(new VComment(value));
    return this.___finishChild();
};

Node_prototype.___appendDocumentFragment = function() {
    return this.___appendChild(new VDocumentFragment());
};

exports.___VComment = VComment;
exports.___VDocumentFragment = VDocumentFragment;
exports.___VElement = VElement;
exports.___VText = VText;
exports.___VComponent = VComponent;
exports.___virtualize = virtualize;
exports.___virtualizeHTML = virtualizeHTML;
exports.___defaultDocument = defaultDocument;

});
$_mod.remap("/marko$4.5.3/src/components/util", "/marko$4.5.3/src/components/util-browser");
$_mod.remap("/marko$4.5.3/src/components/init-components", "/marko$4.5.3/src/components/init-components-browser");
$_mod.installed("marko$4.5.3", "warp10", "1.3.6");
$_mod.def("/warp10$1.3.6/src/finalize", function(require, exports, module, __filename, __dirname) { var isArray = Array.isArray;

function resolve(object, path, len) {
    var current = object;
    for (var i=0; i<len; i++) {
        current = current[path[i]];
    }

    return current;
}

function resolveType(info) {
    if (info.type === 'Date') {
        return new Date(info.value);
    } else {
        throw new Error('Bad type');
    }
}

module.exports = function finalize(outer) {
    if (!outer) {
        return outer;
    }

    var assignments = outer.$$;
    if (assignments) {
        var object = outer.o;
        var len;

        if (assignments && (len=assignments.length)) {
            for (var i=0; i<len; i++) {
                var assignment = assignments[i];

                var rhs = assignment.r;
                var rhsValue;

                if (isArray(rhs)) {
                    rhsValue = resolve(object, rhs, rhs.length);
                } else {
                    rhsValue = resolveType(rhs);
                }

                var lhs = assignment.l;
                var lhsLast = lhs.length-1;

                if (lhsLast === -1) {
                    object = outer.o = rhsValue;
                    break;
                } else {
                    var lhsParent = resolve(object, lhs, lhsLast);
                    lhsParent[lhs[lhsLast]] = rhsValue;
                }
            }
        }

        assignments.length = 0; // Assignments have been applied, do not reapply

        return object == null ? null : object;
    } else {
        return outer;
    }

};
});
$_mod.def("/warp10$1.3.6/finalize", function(require, exports, module, __filename, __dirname) { module.exports = require('/warp10$1.3.6/src/finalize'/*'./src/finalize'*/);
});
$_mod.def("/marko$4.5.3/src/components/bubble", function(require, exports, module, __filename, __dirname) { module.exports = [
    /* Mouse Events */
    'click',
    'dblclick',
    'mousedown',
    'mouseup',
    // 'mouseover',
    // 'mousemove',
    // 'mouseout',
    'dragstart',
    'drag',
    // 'dragenter',
    // 'dragleave',
    // 'dragover',
    'drop',
    'dragend',

    /* Keyboard Events */
    'keydown',
    'keypress',
    'keyup',

    /* Form Events */
    'select',
    'change',
    'submit',
    'reset',
    'input',

    'attach', // Pseudo event supported by Marko
    'detach'  // Pseudo event supported by Marko

    // 'focus', <-- Does not bubble
    // 'blur', <-- Does not bubble
    // 'focusin', <-- Not supported in all browsers
    // 'focusout' <-- Not supported in all browsers
];
});
$_mod.def("/marko$4.5.3/src/components/event-delegation", function(require, exports, module, __filename, __dirname) { var componentsUtil = require('/marko$4.5.3/src/components/util-browser'/*'./util'*/);
var runtimeId = componentsUtil.___runtimeId;
var componentLookup = componentsUtil.___componentLookup;
var getMarkoPropsFromEl = componentsUtil.___getMarkoPropsFromEl;

// We make our best effort to allow multiple marko runtimes to be loaded in the
// same window. Each marko runtime will get its own unique runtime ID.
var listenersAttachedKey = '$MED' + runtimeId;

function getEventFromEl(el, eventName) {
    var virtualProps = getMarkoPropsFromEl(el);
    var eventInfo = virtualProps[eventName];
    if (typeof eventInfo === 'string') {
        eventInfo = eventInfo.split(' ');
        if (eventInfo.length == 3) {
            eventInfo[2] = parseInt(eventInfo[2], 10);
        }
    }

    return eventInfo;
}

function delegateEvent(node, target, event) {
    var targetMethod = target[0];
    var targetComponentId = target[1];
    var extraArgs = target[2];

    var targetComponent = componentLookup[targetComponentId];

    if (!targetComponent) {
        return;
    }

    var targetFunc = targetComponent[targetMethod];
    if (!targetFunc) {
        throw Error('Method not found: ' + targetMethod);
    }

    if (extraArgs != null) {
        if (typeof extraArgs === 'number') {
            extraArgs = targetComponent.___bubblingDomEvents[extraArgs];
        }
    }

    // Invoke the component method
    if (extraArgs) {
        targetFunc.apply(targetComponent, extraArgs.concat(event, node));
    } else {
        targetFunc.call(targetComponent, event, node);
    }
}

function attachBubbleEventListeners(doc) {
    var body = doc.body || doc;
    // Here's where we handle event delegation using our own mechanism
    // for delegating events. For each event that we have white-listed
    // as supporting bubble, we will attach a listener to the root
    // document.body element. When we get notified of a triggered event,
    // we again walk up the tree starting at the target associated
    // with the event to find any mappings for event. Each mapping
    // is from a DOM event type to a method of a component.
    require('/marko$4.5.3/src/components/bubble'/*'./bubble'*/).forEach(function addBubbleHandler(eventType) {
        body.addEventListener(eventType, function(event) {
            var propagationStopped = false;

            // Monkey-patch to fix #97
            var oldStopPropagation = event.stopPropagation;

            event.stopPropagation = function() {
                oldStopPropagation.call(event);
                propagationStopped = true;
            };

            var curNode = event.target;
            if (!curNode) {
                return;
            }

            // event.target of an SVGElementInstance does not have a
            // `getAttribute` function in IE 11.
            // See https://github.com/marko-js/marko/issues/796
            curNode = curNode.correspondingUseElement || curNode;

            // Search up the tree looking DOM events mapped to target
            // component methods
            var propName = 'on' + eventType;
            var target;

            // Attributes will have the following form:
            // on<event_type>("<target_method>|<component_id>")

            do {
                if ((target = getEventFromEl(curNode, propName))) {
                    delegateEvent(curNode, target, event);

                    if (propagationStopped) {
                        break;
                    }
                }
            } while((curNode = curNode.parentNode) && curNode.getAttribute);
        });
    });
}

function noop() {}

exports.___handleNodeAttach = noop;
exports.___handleNodeDetach = noop;
exports.___delegateEvent = delegateEvent;
exports.___getEventFromEl = getEventFromEl;

exports.___init = function(doc) {
    if (!doc[listenersAttachedKey]) {
        doc[listenersAttachedKey] = true;
        attachBubbleEventListeners(doc);
    }
};

});
$_mod.def("/marko$4.5.3/src/components/KeySequence", function(require, exports, module, __filename, __dirname) {  function KeySequence() {
    this.___lookup = {};
}

KeySequence.prototype = {
    ___nextKey: function(key) {
        // var len = key.length;
        // var lastChar = key[len-1];
        // if (lastChar === ']') {
        //     key = key.substring(0, len-2);
        // }
        var lookup = this.___lookup;

        var currentIndex = lookup[key]++;
        if (!currentIndex) {
            lookup[key] = 1;
            currentIndex = 0;
            return key;
        } else {
            return key + '_' + currentIndex;
        }


    }
};

module.exports = KeySequence;

});
$_mod.def("/marko$4.5.3/src/components/ComponentDef", function(require, exports, module, __filename, __dirname) { 'use strict';
var repeatedRegExp = /\[\]$/;
var componentUtil = require('/marko$4.5.3/src/components/util-browser'/*'./util'*/);
var attachBubblingEvent = componentUtil.___attachBubblingEvent;
var extend = require('/raptor-util$3.2.0/extend'/*'raptor-util/extend'*/);
var KeySequence = require('/marko$4.5.3/src/components/KeySequence'/*'./KeySequence'*/);

/*
var FLAG_WILL_RERENDER_IN_BROWSER = 1;
var FLAG_HAS_BODY_EL = 2;
var FLAG_HAS_HEAD_EL = 4;
*/

/**
 * A ComponentDef is used to hold the metadata collected at runtime for
 * a single component and this information is used to instantiate the component
 * later (after the rendered HTML has been added to the DOM)
 */
function ComponentDef(component, componentId, globalComponentsContext) {
    this.___globalComponentsContext = globalComponentsContext; // The AsyncWriter that this component is associated with
    this.___component = component;
    this.id = componentId;

    this.___domEvents = undefined;         // An array of DOM events that need to be added (in sets of three)

    this.___isExisting = false;

    this.___renderBoundary = false;
    this.___flags = 0;

    this.___nextIdIndex = 0; // The unique integer to use for the next scoped ID

    this.___keySequence = null;

    this.___preservedDOMNodes = null;
}

ComponentDef.prototype = {

    ___nextKey: function(key) {
        var keySequence = this.___keySequence || (this.___keySequence = new KeySequence());
        return keySequence.___nextKey(key);
    },

    ___preserveDOMNode: function(key, bodyOnly) {
        var lookup = this.___preservedDOMNodes || (this.___preservedDOMNodes = {});
        lookup[key] = bodyOnly ? 2 : 1;
    },

    /**
     * This helper method generates a unique and fully qualified DOM element ID
     * that is unique within the scope of the current component. This method prefixes
     * the the nestedId with the ID of the current component. If nestedId ends
     * with `[]` then it is treated as a repeated ID and we will generate
     * an ID with the current index for the current nestedId.
     * (e.g. "myParentId-foo[0]", "myParentId-foo[1]", etc.)
     */
    elId: function (nestedId) {
        var id = this.id;
        if (nestedId == null) {
            return id;
        } else {
            if (typeof nestedId == 'string' && repeatedRegExp.test(nestedId)) {
                return this.___globalComponentsContext.___nextRepeatedId(id, nestedId);
            } else {
                return id + '-' + nestedId;
            }
        }
    },
    /**
     * Registers a DOM event for a nested HTML element associated with the
     * component. This is only done for non-bubbling events that require
     * direct event listeners to be added.
     * @param  {String} type The DOM event type ("mouseover", "mousemove", etc.)
     * @param  {String} targetMethod The name of the method to invoke on the scoped component
     * @param  {String} elId The DOM element ID of the DOM element that the event listener needs to be added too
     */
     e: function(type, targetMethod, elId, extraArgs) {
        if (targetMethod) {
            // The event handler method is allowed to be conditional. At render time if the target
            // method is null then we do not attach any direct event listeners.
            (this.___domEvents || (this.___domEvents = [])).push([
                type,
                targetMethod,
                elId,
                extraArgs]);
        }
    },
    /**
     * Returns the next auto generated unique ID for a nested DOM element or nested DOM component
     */
    ___nextComponentId: function() {
        return this.id + '-c' + (this.___nextIdIndex++);
    },

    d: function(handlerMethodName, extraArgs) {
        return attachBubblingEvent(this, handlerMethodName, extraArgs);
    },

    get ___type() {
        return this.___component.___type;
    }
};

ComponentDef.___deserialize = function(o, types, globals, registry) {
    var id        = o[0];
    var typeName  = types[o[1]];
    var input     = o[2];
    var extra     = o[3];

    var state = extra.s;
    var componentProps = extra.w;

    var component = typeName /* legacy */ && registry.___createComponent(typeName, id);

    if (extra.b) {
        component.___bubblingDomEvents = extra.b;
    }

    // Preview newly created component from being queued for update since we area
    // just building it from the server info
    component.___updateQueued = true;

    if (state) {
        var undefinedPropNames = extra.u;
        if (undefinedPropNames) {
            undefinedPropNames.forEach(function(undefinedPropName) {
                state[undefinedPropName] = undefined;
            });
        }
        // We go through the setter here so that we convert the state object
        // to an instance of `State`
        component.state = state;
    }

    component.___input = input;

    if (componentProps) {
        extend(component, componentProps);
    }

    var scope = extra.p;
    var customEvents = extra.e;
    if (customEvents) {
        component.___setCustomEvents(customEvents, scope);
    }

    component.___global = globals;

    return {
        id: id,
        ___component: component,
        ___boundary: extra.r,
        ___domEvents: extra.d,
        ___flags: extra.f || 0
    };
};

module.exports = ComponentDef;

});
$_mod.remap("/marko$4.5.3/src/components/registry", "/marko$4.5.3/src/components/registry-browser");
$_mod.remap("/marko$4.5.3/src/components/loadComponent", "/marko$4.5.3/src/components/loadComponent-dynamic");
$_mod.def("/marko$4.5.3/src/components/loadComponent-dynamic", function(require, exports, module, __filename, __dirname) { 'use strict';

module.exports = function load(typeName) {
    // We make the assumption that the component type name is a path to a
    // fully resolved module path and that the module exists
    // as a CommonJS module
    return require(typeName);
};
});
$_mod.def("/marko$4.5.3/src/components/State", function(require, exports, module, __filename, __dirname) { var extend = require('/raptor-util$3.2.0/extend'/*'raptor-util/extend'*/);

function ensure(state, propertyName) {
    var proto = state.constructor.prototype;
    if (!(propertyName in proto)) {
        Object.defineProperty(proto, propertyName, {
            get: function() {
                return this.___raw[propertyName];
            },
            set: function(value) {
                this.___set(propertyName, value, false /* ensure:false */);
            }
        });
    }
}

function State(component) {
    this.___component = component;
    this.___raw = {};

    this.___dirty = false;
    this.___old = null;
    this.___changes = null;
    this.___forced = null; // An object that we use to keep tracking of state properties that were forced to be dirty

    Object.seal(this);
}

State.prototype = {
    ___reset: function() {
        var self = this;

        self.___dirty = false;
        self.___old = null;
        self.___changes = null;
        self.___forced = null;
    },

    ___replace: function(newState) {
        var state = this;
        var key;

        var rawState = this.___raw;

        for (key in rawState) {
            if (!(key in newState)) {
                state.___set(key, undefined, false /* ensure:false */, false /* forceDirty:false */);
            }
        }

        for (key in newState) {
            state.___set(key, newState[key], true /* ensure:true */, false /* forceDirty:false */);
        }
    },
    ___set: function(name, value, shouldEnsure, forceDirty) {
        var rawState = this.___raw;

        if (shouldEnsure) {
            ensure(this, name);
        }

        if (forceDirty) {
            var forcedDirtyState = this.___forced || (this.___forced = {});
            forcedDirtyState[name] = true;
        } else if (rawState[name] === value) {
            return;
        }

        if (!this.___dirty) {
            // This is the first time we are modifying the component state
            // so introduce some properties to do some tracking of
            // changes to the state
            this.___dirty = true; // Mark the component state as dirty (i.e. modified)
            this.___old = rawState;
            this.___raw = rawState = extend({}, rawState);
            this.___changes = {};
            this.___component.___queueUpdate();
        }

        this.___changes[name] = value;

        if (value === undefined) {
            // Don't store state properties with an undefined or null value
            delete rawState[name];
        } else {
            // Otherwise, store the new value in the component state
            rawState[name] = value;
        }
    },
    toJSON: function() {
        return this.___raw;
    }
};

module.exports = State;

});
$_mod.def("/marko$4.5.3/src/components/GlobalComponentsContext", function(require, exports, module, __filename, __dirname) { var nextComponentIdProvider = require('/marko$4.5.3/src/components/util-browser'/*'./util'*/).___nextComponentIdProvider;
var KeySequence = require('/marko$4.5.3/src/components/KeySequence'/*'./KeySequence'*/);

function GlobalComponentsContext(out) {
    this.___preservedEls = {};
    this.___preservedElBodies = {};
    this.___renderedComponentsById = {};
    this.___rerenderComponent = undefined;
    this.___nextComponentId = nextComponentIdProvider(out);
}

GlobalComponentsContext.prototype = {
    ___createKeySequence: function() {
        return new KeySequence();
    }
};

module.exports = GlobalComponentsContext;

});
$_mod.def("/marko$4.5.3/src/components/ComponentsContext", function(require, exports, module, __filename, __dirname) { 'use strict';
var GlobalComponentsContext = require('/marko$4.5.3/src/components/GlobalComponentsContext'/*'./GlobalComponentsContext'*/);

function ComponentsContext(out, parentComponentsContext) {
    var globalComponentsContext;
    var componentDef;

    if (parentComponentsContext) {
        globalComponentsContext = parentComponentsContext.___globalContext;
        componentDef = parentComponentsContext.___componentDef;

        var nestedContextsForParent;
        if (!(nestedContextsForParent = parentComponentsContext.___nestedContexts)) {
            nestedContextsForParent = parentComponentsContext.___nestedContexts = [];
        }

        nestedContextsForParent.push(this);
    } else {
        globalComponentsContext = out.global.___components;
        if (globalComponentsContext === undefined) {
            out.global.___components = globalComponentsContext = new GlobalComponentsContext(out);
        }
    }

    this.___globalContext = globalComponentsContext;
    this.___components = [];
    this.___out = out;
    this.___componentDef = componentDef;
    this.___nestedContexts = undefined;
}

ComponentsContext.prototype = {
    ___initComponents: function(doc) {
        var componentDefs = this.___components;

        ComponentsContext.___initClientRendered(componentDefs, doc);

        this.___out.emit('___componentsInitialized');

        // Reset things stored in global since global is retained for
        // future renders
        this.___out.global.___components = undefined;

        return componentDefs;
    },
};

function getComponentsContext(out) {
    return out.___components || (out.___components = new ComponentsContext(out));
}

module.exports = exports = ComponentsContext;

exports.___getComponentsContext = getComponentsContext;

});
$_mod.installed("marko$4.5.3", "listener-tracker", "2.0.0");
$_mod.main("/listener-tracker$2.0.0", "lib/listener-tracker");
$_mod.def("/listener-tracker$2.0.0/lib/listener-tracker", function(require, exports, module, __filename, __dirname) { var INDEX_EVENT = 0;
var INDEX_USER_LISTENER = 1;
var INDEX_WRAPPED_LISTENER = 2;
var DESTROY = "destroy";

function isNonEventEmitter(target) {
  return !target.once;
}

function EventEmitterWrapper(target) {
    this.$__target = target;
    this.$__listeners = [];
    this.$__subscribeTo = null;
}

EventEmitterWrapper.prototype = {
    $__remove: function(test, testWrapped) {
        var target = this.$__target;
        var listeners = this.$__listeners;

        this.$__listeners = listeners.filter(function(curListener) {
            var curEvent = curListener[INDEX_EVENT];
            var curListenerFunc = curListener[INDEX_USER_LISTENER];
            var curWrappedListenerFunc = curListener[INDEX_WRAPPED_LISTENER];

            if (testWrapped) {
                // If the user used `once` to attach an event listener then we had to
                // wrap their listener function with a new function that does some extra
                // cleanup to avoid a memory leak. If the `testWrapped` flag is set to true
                // then we are attempting to remove based on a function that we had to
                // wrap (not the user listener function)
                if (curWrappedListenerFunc && test(curEvent, curWrappedListenerFunc)) {
                    target.removeListener(curEvent, curWrappedListenerFunc);

                    return false;
                }
            } else if (test(curEvent, curListenerFunc)) {
                // If the listener function was wrapped due to it being a `once` listener
                // then we should remove from the target EventEmitter using wrapped
                // listener function. Otherwise, we remove the listener using the user-provided
                // listener function.
                target.removeListener(curEvent, curWrappedListenerFunc || curListenerFunc);

                return false;
            }

            return true;
        });

        // Fixes https://github.com/raptorjs/listener-tracker/issues/2
        // If all of the listeners stored with a wrapped EventEmitter
        // have been removed then we should unregister the wrapped
        // EventEmitter in the parent SubscriptionTracker
        var subscribeTo = this.$__subscribeTo;

        if (!this.$__listeners.length && subscribeTo) {
            var self = this;
            var subscribeToList = subscribeTo.$__subscribeToList;
            subscribeTo.$__subscribeToList = subscribeToList.filter(function(cur) {
                return cur !== self;
            });
        }
    },

    on: function(event, listener) {
        this.$__target.on(event, listener);
        this.$__listeners.push([event, listener]);
        return this;
    },

    once: function(event, listener) {
        var self = this;

        // Handling a `once` event listener is a little tricky since we need to also
        // do our own cleanup if the `once` event is emitted. Therefore, we need
        // to wrap the user's listener function with our own listener function.
        var wrappedListener = function() {
            self.$__remove(function(event, listenerFunc) {
                return wrappedListener === listenerFunc;
            }, true /* We are removing the wrapped listener */);

            listener.apply(this, arguments);
        };

        this.$__target.once(event, wrappedListener);
        this.$__listeners.push([event, listener, wrappedListener]);
        return this;
    },

    removeListener: function(event, listener) {
        if (typeof event === 'function') {
            listener = event;
            event = null;
        }

        if (listener && event) {
            this.$__remove(function(curEvent, curListener) {
                return event === curEvent && listener === curListener;
            });
        } else if (listener) {
            this.$__remove(function(curEvent, curListener) {
                return listener === curListener;
            });
        } else if (event) {
            this.removeAllListeners(event);
        }

        return this;
    },

    removeAllListeners: function(event) {

        var listeners = this.$__listeners;
        var target = this.$__target;

        if (event) {
            this.$__remove(function(curEvent, curListener) {
                return event === curEvent;
            });
        } else {
            for (var i = listeners.length - 1; i >= 0; i--) {
                var cur = listeners[i];
                target.removeListener(cur[INDEX_EVENT], cur[INDEX_USER_LISTENER]);
            }
            this.$__listeners.length = 0;
        }

        return this;
    }
};

function EventEmitterAdapter(target) {
    this.$__target = target;
}

EventEmitterAdapter.prototype = {
    on: function(event, listener) {
        this.$__target.addEventListener(event, listener);
        return this;
    },

    once: function(event, listener) {
        var self = this;

        // need to save this so we can remove it below
        var onceListener = function() {
          self.$__target.removeEventListener(event, onceListener);
          listener();
        };
        this.$__target.addEventListener(event, onceListener);
        return this;
    },

    removeListener: function(event, listener) {
        this.$__target.removeEventListener(event, listener);
        return this;
    }
};

function SubscriptionTracker() {
    this.$__subscribeToList = [];
}

SubscriptionTracker.prototype = {

    subscribeTo: function(target, options) {
        var addDestroyListener = !options || options.addDestroyListener !== false;
        var wrapper;
        var nonEE;
        var subscribeToList = this.$__subscribeToList;

        for (var i=0, len=subscribeToList.length; i<len; i++) {
            var cur = subscribeToList[i];
            if (cur.$__target === target) {
                wrapper = cur;
                break;
            }
        }

        if (!wrapper) {
            if (isNonEventEmitter(target)) {
              nonEE = new EventEmitterAdapter(target);
            }

            wrapper = new EventEmitterWrapper(nonEE || target);
            if (addDestroyListener && !nonEE) {
                wrapper.once(DESTROY, function() {
                    wrapper.removeAllListeners();

                    for (var i = subscribeToList.length - 1; i >= 0; i--) {
                        if (subscribeToList[i].$__target === target) {
                            subscribeToList.splice(i, 1);
                            break;
                        }
                    }
                });
            }

            // Store a reference to the parent SubscriptionTracker so that we can do cleanup
            // if the EventEmitterWrapper instance becomes empty (i.e., no active listeners)
            wrapper.$__subscribeTo = this;
            subscribeToList.push(wrapper);
        }

        return wrapper;
    },

    removeAllListeners: function(target, event) {
        var subscribeToList = this.$__subscribeToList;
        var i;

        if (target) {
            for (i = subscribeToList.length - 1; i >= 0; i--) {
                var cur = subscribeToList[i];
                if (cur.$__target === target) {
                    cur.removeAllListeners(event);

                    if (!cur.$__listeners.length) {
                        // Do some cleanup if we removed all
                        // listeners for the target event emitter
                        subscribeToList.splice(i, 1);
                    }

                    break;
                }
            }
        } else {
            for (i = subscribeToList.length - 1; i >= 0; i--) {
                subscribeToList[i].removeAllListeners();
            }
            subscribeToList.length = 0;
        }
    }
};

exports = module.exports = SubscriptionTracker;

exports.wrap = function(targetEventEmitter) {
    var nonEE;
    var wrapper;

    if (isNonEventEmitter(targetEventEmitter)) {
      nonEE = new EventEmitterAdapter(targetEventEmitter);
    }

    wrapper = new EventEmitterWrapper(nonEE || targetEventEmitter);
    if (!nonEE) {
      // we don't set this for non EE types
      targetEventEmitter.once(DESTROY, function() {
          wrapper.$__listeners.length = 0;
      });
    }

    return wrapper;
};

exports.createTracker = function() {
    return new SubscriptionTracker();
};

});
$_mod.remap("/marko$4.5.3/src/runtime/nextTick", "/marko$4.5.3/src/runtime/nextTick-browser");
$_mod.def("/marko$4.5.3/src/runtime/nextTick-browser", function(require, exports, module, __filename, __dirname) { /* globals window */

var win = window;
var setImmediate = win.setImmediate;

if (!setImmediate) {
    if (win.postMessage) {
        var queue = [];
        var messageName = 'si';
        win.addEventListener('message', function (event) {
            var source = event.source;
            if (source == win || !source && event.data === messageName) {
                event.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        setImmediate = function(fn) {
            queue.push(fn);
            win.postMessage(messageName, '*');
        };
    } else {
        setImmediate = setTimeout;
    }
}

module.exports = setImmediate;

});
$_mod.def("/marko$4.5.3/src/components/update-manager", function(require, exports, module, __filename, __dirname) { 'use strict';

var updatesScheduled = false;
var batchStack = []; // A stack of batched updates
var unbatchedQueue = []; // Used for scheduled batched updates

var nextTick = require('/marko$4.5.3/src/runtime/nextTick-browser'/*'../runtime/nextTick'*/);

/**
 * This function is called when we schedule the update of "unbatched"
 * updates to components.
 */
function updateUnbatchedComponents() {
    if (unbatchedQueue.length) {
        try {
            updateComponents(unbatchedQueue);
        } finally {
            // Reset the flag now that this scheduled batch update
            // is complete so that we can later schedule another
            // batched update if needed
            updatesScheduled = false;
        }
    }
}

function scheduleUpdates() {
    if (updatesScheduled) {
        // We have already scheduled a batched update for the
        // process.nextTick so nothing to do
        return;
    }

    updatesScheduled = true;

    nextTick(updateUnbatchedComponents);
}

function updateComponents(queue) {
    // Loop over the components in the queue and update them.
    // NOTE: It is okay if the queue grows during the iteration
    //       since we will still get to them at the end
    for (var i=0; i<queue.length; i++) {
        var component = queue[i];
        component.___update(); // Do the actual component update
    }

    // Clear out the queue by setting the length to zero
    queue.length = 0;
}

function batchUpdate(func) {
    // If the batched update stack is empty then this
    // is the outer batched update. After the outer
    // batched update completes we invoke the "afterUpdate"
    // event listeners.
    var batch = {
        ___queue: null
    };

    batchStack.push(batch);

    try {
        func();
    } finally {
        try {
            // Update all of the components that where queued up
            // in this batch (if any)
            if (batch.___queue) {
                updateComponents(batch.___queue);
            }
        } finally {
            // Now that we have completed the update of all the components
            // in this batch we need to remove it off the top of the stack
            batchStack.length--;
        }
    }
}

function queueComponentUpdate(component) {
    var batchStackLen = batchStack.length;

    if (batchStackLen) {
        // When a batch update is started we push a new batch on to a stack.
        // If the stack has a non-zero length then we know that a batch has
        // been started so we can just queue the component on the top batch. When
        // the batch is ended this component will be updated.
        var batch = batchStack[batchStackLen-1];

        // We default the batch queue to null to avoid creating an Array instance
        // unnecessarily. If it is null then we create a new Array, otherwise
        // we push it onto the existing Array queue
        if (batch.___queue) {
            batch.___queue.push(component);
        } else {
            batch.___queue = [component];
        }
    } else {
        // We are not within a batched update. We need to schedule a batch update
        // for the process.nextTick (if that hasn't been done already) and we will
        // add the component to the unbatched queued
        scheduleUpdates();
        unbatchedQueue.push(component);
    }
}

exports.___queueComponentUpdate = queueComponentUpdate;
exports.___batchUpdate = batchUpdate;

});
$_mod.main("/marko$4.5.3/src/morphdom", "");
$_mod.def("/marko$4.5.3/src/morphdom/specialElHandlers", function(require, exports, module, __filename, __dirname) { function syncBooleanAttrProp(fromEl, toEl, name) {
    if (fromEl[name] !== toEl[name]) {
        fromEl[name] = toEl[name];
        if (fromEl[name]) {
            fromEl.setAttribute(name, '');
        } else {
            fromEl.removeAttribute(name, '');
        }
    }
}

// We use a JavaScript class to benefit from fast property lookup
function SpecialElHandlers() {}
SpecialElHandlers.prototype = {
    /**
     * Needed for IE. Apparently IE doesn't think that "selected" is an
     * attribute when reading over the attributes using selectEl.attributes
     */
    OPTION: function(fromEl, toEl) {
        syncBooleanAttrProp(fromEl, toEl, 'selected');
    },
    /**
     * The "value" attribute is special for the <input> element since it sets
     * the initial value. Changing the "value" attribute without changing the
     * "value" property will have no effect since it is only used to the set the
     * initial value.  Similar for the "checked" attribute, and "disabled".
     */
    INPUT: function(fromEl, toEl) {
        syncBooleanAttrProp(fromEl, toEl, 'checked');
        syncBooleanAttrProp(fromEl, toEl, 'disabled');

        if (fromEl.value != toEl.___value) {
            fromEl.value = toEl.___value;
        }

        if (!toEl.___hasAttribute('value')) {
            fromEl.removeAttribute('value');
        }
    },

    TEXTAREA: function(fromEl, toEl) {
        var newValue = toEl.___value;
        if (fromEl.value != newValue) {
            fromEl.value = newValue;
        }

        var firstChild = fromEl.firstChild;
        if (firstChild) {
            // Needed for IE. Apparently IE sets the placeholder as the
            // node value and vise versa. This ignores an empty update.
            var oldValue = firstChild.nodeValue;

            if (oldValue == newValue || (!newValue && oldValue == fromEl.placeholder)) {
                return;
            }

            firstChild.nodeValue = newValue;
        }
    },
    SELECT: function(fromEl, toEl) {
        if (!toEl.___hasAttribute('multiple')) {
            var selectedIndex = -1;
            var i = 0;
            var curChild = toEl.___firstChild;
            while(curChild) {
                if (curChild.___nodeName == 'OPTION') {
                    if (curChild.___hasAttribute('selected')) {
                        selectedIndex = i;
                        break;
                    }
                    i++;
                }
                curChild = curChild.___nextSibling;
            }

            fromEl.selectedIndex = i;
        }
    }
};

module.exports = new SpecialElHandlers();

});
$_mod.def("/marko$4.5.3/src/morphdom/index", function(require, exports, module, __filename, __dirname) { 'use strict';
var specialElHandlers = require('/marko$4.5.3/src/morphdom/specialElHandlers'/*'./specialElHandlers'*/);
var componentsUtil = require('/marko$4.5.3/src/components/util-browser'/*'../components/util'*/);
var existingComponentLookup = componentsUtil.___componentLookup;
var destroyNodeRecursive = componentsUtil.___destroyNodeRecursive;
var VElement = require('/marko$4.5.3/src/runtime/vdom/vdom'/*'../runtime/vdom/vdom'*/).___VElement;
var virtualizeElement =  VElement.___virtualize;
var morphAttrs = VElement.___morphAttrs;
var eventDelegation = require('/marko$4.5.3/src/components/event-delegation'/*'../components/event-delegation'*/);

var ELEMENT_NODE = 1;
var TEXT_NODE = 3;
var COMMENT_NODE = 8;
var COMPONENT_NODE = 2;

// var FLAG_IS_SVG = 1;
// var FLAG_IS_TEXTAREA = 2;
// var FLAG_SIMPLE_ATTRS = 4;
var FLAG_PRESERVE = 8;
// var FLAG_CUSTOM_ELEMENT = 16;

function compareNodeNames(fromEl, toEl) {
    return fromEl.___nodeName === toEl.___nodeName;
}

function onNodeAdded(node, componentsContext) {
    if (node.nodeType === 1) {
        eventDelegation.___handleNodeAttach(node, componentsContext);
    }
}

function insertBefore(node, referenceNode, parentNode) {
    return parentNode.insertBefore(node, referenceNode);
}

function insertAfter(node, referenceNode, parentNode) {
    return parentNode.insertBefore(node, referenceNode && referenceNode.nextSibling);
}

function morphdom(
        parentNode,
        startNode,
        endNode,
        toNode,
        doc,
        componentsContext
    ) {
    var globalComponentsContext;
    var isRerenderInBrowser = false;

    if (componentsContext) {
        globalComponentsContext = componentsContext.___globalContext;
        isRerenderInBrowser = globalComponentsContext.___isRerenderInBrowser;
    }

    function createMarkerComment(referenceNode, parentNode) {
        return doc.createComment('$marko');
    }

    function insertVirtualNodeBefore(vNode, key, referenceEl, parentEl, component) {
        var realNode = vNode.___actualize(doc);
        insertBefore(realNode, referenceEl, parentEl);

        if (vNode.___nodeType === ELEMENT_NODE) {
            if (key) {
                realNode.___markoKey = key;
                component.___keyedElements[key] = realNode;
            }

            morphChildren(realNode, null, null, vNode, component);
        }

        onNodeAdded(realNode, componentsContext);
    }

    function insertVirtualComponentBefore(vComponent, referenceNode, referenceNodeParentEl, component) {
        component.___startNode = component.___endNode = insertBefore(createMarkerComment(), referenceNode, referenceNodeParentEl);
        morphComponent(referenceNodeParentEl, component, vComponent);
    }

    function resolveComponentEndNode(startNode, vChild, parentNode) {
        var endNode = startNode;

        // We track text nodes because multiple adjacent VText nodes should
        // be treated as a single VText node for purposes of pairing with HTML
        // that was rendered on the server since browsers will only see
        // a single text node
        var isPrevText = vChild.___nodeType === TEXT_NODE;

        while((vChild = vChild.___nextSibling)) {
            var nextRealNode = endNode.nextSibling;

            // We stop when there are no more corresponding real nodes or when
            // we reach the end boundary for our UI component
            if (!nextRealNode || nextRealNode.___endNode) {
                break;
            }
            var isText = vChild.___nodeType === TEXT_NODE;
            if (isText && isPrevText) {
                // Pretend like we didn't see this VText node since it
                // the previous vnode was also a VText node
                continue;
            }
            endNode = nextRealNode;
            isPrevText = isText;
        }

        return endNode;
    }

    function morphComponent(parentFromNode, component, vComponent) {
        // We create a key sequence to generate unique keys since a key
        // can be repeated
        component.___keySequence = globalComponentsContext.___createKeySequence();

        var startNode = component.___startNode;
        var endNode = component.___endNode;
        startNode.___markoComponent = undefined;
        endNode.___endNode = undefined;

        var beforeChild = startNode.previousSibling;
        var afterChild = endNode.nextSibling;

        morphChildren(parentFromNode, startNode, afterChild, vComponent, component);

        endNode = undefined;

        if (beforeChild) {
            startNode = beforeChild.nextSibling;
            if (!startNode || startNode === afterChild) {
                startNode = endNode = insertAfter(createMarkerComment(), beforeChild, parentFromNode);
            }
        } else {
            startNode = parentFromNode.firstChild;
            if (!startNode) {
                startNode = endNode = insertAfter(createMarkerComment(), beforeChild, parentFromNode);
            }
        }

        if (!endNode) {
            if (afterChild) {
                endNode = afterChild.previousSibling;
            } else {
                endNode = parentFromNode.lastChild;
            }
        }

        // Make sure we don't use a detached node as the component boundary and
        // we can't use a node that is already the boundary node for another component
        if (startNode.___markoDetached !== undefined || startNode.___markoComponent) {
            startNode = insertBefore(createMarkerComment(), startNode, parentFromNode);
        }

        if (endNode.___markoDetached !== undefined || endNode.___endNode) {
            endNode = insertAfter(createMarkerComment(), endNode, parentFromNode);
        }

        startNode.___markoComponent = component;
        endNode.___endNode = true;

        component.___startNode = startNode;
        component.___endNode = endNode;

        component.___keySequence = undefined; // We don't need to track keys anymore

        return afterChild;
    }

    var detachedNodes = [];

    function detachNode(node, parentNode, component) {
        if (node.nodeType === ELEMENT_NODE) {
            detachedNodes.push(node);
            node.___markoDetached = component || true;
        } else {
            destroyNodeRecursive(node);
            parentNode.removeChild(node);
        }
    }

    function destroyComponent(component) {
        component.destroy();
    }

    function morphChildren(parentFromNode, startNode, endNode, toNode, component) {
        var curFromNodeChild = startNode;
        var curToNodeChild = toNode.___firstChild;

        var curToNodeKey;
        var curFromNodeKey;
        var curToNodeType;

        var fromNextSibling;
        var toNextSibling;
        var matchingFromEl;
        var matchingFromComponent;
        var curVFromNodeChild;
        var fromComponent;

        outer: while (curToNodeChild) {
            toNextSibling = curToNodeChild.___nextSibling;
            curToNodeType = curToNodeChild.___nodeType;

            var componentForNode = curToNodeChild.___component || component;

            if (curToNodeType === COMPONENT_NODE) {

                if ((matchingFromComponent = existingComponentLookup[componentForNode.id]) === undefined) {
                    if (isRerenderInBrowser === true) {
                        var firstVChild = curToNodeChild.___firstChild;
                        if (firstVChild) {
                            if (!curFromNodeChild) {
                                curFromNodeChild = insertBefore(createMarkerComment(), null, parentFromNode);
                            }

                            componentForNode.___startNode = curFromNodeChild;
                            componentForNode.___endNode = resolveComponentEndNode(curFromNodeChild, firstVChild, parentFromNode);

                        }  else {
                            componentForNode.___startNode = componentForNode.___endNode = insertBefore(createMarkerComment(), curFromNodeChild, parentFromNode);
                        }

                        curFromNodeChild = morphComponent(parentFromNode, componentForNode, curToNodeChild);
                    } else {
                        insertVirtualComponentBefore(curToNodeChild, curFromNodeChild, parentFromNode, componentForNode);
                    }
                } else {
                    if (matchingFromComponent.___startNode !== curFromNodeChild) {
                        if (curFromNodeChild &&
                            (fromComponent = curFromNodeChild.___markoComponent) &&
                            globalComponentsContext.___renderedComponentsById[fromComponent.id] === undefined) {

                            // The component associated with the current real DOM node was not rendered
                            // so we should just remove it out of the real DOM by destroying it
                            curFromNodeChild = fromComponent.___endNode.nextSibling;
                            destroyComponent(fromComponent);
                            continue;
                        }

                        // We need to move the existing component into
                        // the correct location
                        insertBefore(matchingFromComponent.___detach(), curFromNodeChild, parentFromNode);
                    }

                    if (curToNodeChild.___preserve) {
                        curFromNodeChild = matchingFromComponent.___endNode.nextSibling;
                    } else {
                        curFromNodeChild = morphComponent(parentFromNode, componentForNode, curToNodeChild);
                    }
                }

                curToNodeChild = toNextSibling;
                continue;
            } else if ((curToNodeKey = curToNodeChild.___key)) {
                curVFromNodeChild = undefined;
                curFromNodeKey = undefined;

                var keySequence = componentForNode.___keySequence ||
                    (componentForNode.___keySequence = globalComponentsContext.___createKeySequence());

                // We have a keyed element. This is the fast path for matching
                // up elements
                curToNodeKey = keySequence.___nextKey(curToNodeKey);


                if (curFromNodeChild) {
                    if (curFromNodeChild !== endNode) {
                        curFromNodeKey = curFromNodeChild.___markoKey;
                        curVFromNodeChild = curFromNodeChild.___markoVElement;
                        fromNextSibling = curFromNodeChild.nextSibling;
                    }
                }

                if (curFromNodeKey === curToNodeKey) {
                    // Elements line up. Now we just have to make sure they are compatible
                    if ((curToNodeChild.___flags & FLAG_PRESERVE) === 0) {
                        // We just skip over the fromNode if it is preserved


                        if (compareNodeNames(curToNodeChild, curVFromNodeChild)) {
                            morphEl(curFromNodeChild, curVFromNodeChild, curToNodeChild, componentForNode, curToNodeKey);
                        } else {
                            // Remove the old node
                            detachNode(curFromNodeChild, parentFromNode, componentForNode);

                            // Incompatible nodes. Just move the target VNode into the DOM at this position
                            insertVirtualNodeBefore(curToNodeChild, curToNodeKey, curFromNodeChild, parentFromNode, componentForNode);
                        }
                    }
                } else {
                    if ((matchingFromEl = componentForNode.___keyedElements[curToNodeKey]) === undefined) {
                        if (isRerenderInBrowser === true && curFromNodeChild &&
                                curFromNodeChild.nodeType === ELEMENT_NODE &&
                                curFromNodeChild.nodeName === curToNodeChild.___nodeName) {
                            curVFromNodeChild = virtualizeElement(curFromNodeChild);
                            curFromNodeChild.___markoKey = curToNodeKey;
                            morphEl(curFromNodeChild, curVFromNodeChild, curToNodeChild, componentForNode, curToNodeKey);
                            curToNodeChild = toNextSibling;
                            curFromNodeChild = fromNextSibling;
                            continue;
                        }

                        insertVirtualNodeBefore(curToNodeChild, curToNodeKey, curFromNodeChild, parentFromNode, componentForNode);
                        fromNextSibling = curFromNodeChild;
                    } else {
                        if (matchingFromEl.___markoDetached !== undefined) {
                            matchingFromEl.___markoDetached = undefined;
                        }
                        curVFromNodeChild = matchingFromEl.___markoVElement;

                        if (compareNodeNames(curVFromNodeChild, curToNodeChild)) {
                            if (fromNextSibling === matchingFromEl) {
                                // Single element removal:
                                // A <-> A
                                // B <-> C <-- We are here
                                // C     D
                                // D
                                //
                                // Single element swap:
                                // A <-> A
                                // B <-> C <-- We are here
                                // C     B

                                if (toNextSibling && toNextSibling.___key === curFromNodeKey) {
                                    // Single element swap

                                    // We want to stay on the current real DOM node
                                    fromNextSibling = curFromNodeChild;

                                    // But move the matching element into place
                                    insertBefore(matchingFromEl, curFromNodeChild, parentFromNode);
                                } else {
                                    // Single element removal

                                    // We need to remove the current real DOM node
                                    // and the matching real DOM node will fall into
                                    // place. We will continue diffing with next sibling
                                    // after the real DOM node that just fell into place
                                    fromNextSibling = fromNextSibling.nextSibling;

                                    if (curFromNodeChild) {
                                        detachNode(curFromNodeChild, parentFromNode, componentForNode);
                                    }
                                }

                            } else {
                                // A <-> A
                                // B <-> D <-- We are here
                                // C
                                // D

                                // We need to move the matching node into place
                                insertAfter(matchingFromEl, curFromNodeChild, parentFromNode);

                                if (curFromNodeChild) {
                                    detachNode(curFromNodeChild, parentFromNode, componentForNode);
                                }
                            }

                            if ((curToNodeChild.___flags & FLAG_PRESERVE) === 0) {
                                morphEl(matchingFromEl, curVFromNodeChild, curToNodeChild, componentForNode, curToNodeKey, curToNodeKey);
                            }


                        } else {
                            insertVirtualNodeBefore(curToNodeChild, curToNodeKey, curFromNodeChild, parentFromNode, componentForNode);
                            detachNode(matchingFromEl, parentFromNode, componentForNode);
                        }
                    }
                }

                curToNodeChild = toNextSibling;
                curFromNodeChild = fromNextSibling;
                continue;
            }

            // The know the target node is not a VComponent node and we know
            // it is also not a preserve node. Let's now match up the HTML
            // element, text node, comment, etc.
            while (curFromNodeChild && curFromNodeChild !== endNode) {
                if ((fromComponent = curFromNodeChild.___markoComponent) && fromComponent !== componentForNode) {
                    // The current "to" element is not associated with a component,
                    // but the current "from" element is associated with a component

                    // Even if we destroy the current component in the original
                    // DOM or not, we still need to skip over it since it is
                    // not compatible with the current "to" node
                    curFromNodeChild = fromComponent.___endNode.nextSibling;

                    if (!globalComponentsContext.___renderedComponentsById[fromComponent.id]) {
                        destroyComponent(fromComponent);
                    }

                    continue; // Move to the next "from" node
                }

                fromNextSibling = curFromNodeChild.nextSibling;

                var curFromNodeType = curFromNodeChild.nodeType;

                var isCompatible = undefined;

                if (curFromNodeType === curToNodeType) {
                    if (curFromNodeType === ELEMENT_NODE) {
                        // Both nodes being compared are Element nodes
                        curVFromNodeChild = curFromNodeChild.___markoVElement;
                        if (curVFromNodeChild === undefined) {
                            if (isRerenderInBrowser === true) {
                                curVFromNodeChild = virtualizeElement(curFromNodeChild);
                            } else {
                                // Skip over nodes that don't look like ours...
                                curFromNodeChild = fromNextSibling;
                                continue;
                            }
                        } else if ((curFromNodeKey = curVFromNodeChild.___key)) {
                            // We have a keyed element here but our target VDOM node
                            // is not keyed so this not doesn't belong
                            isCompatible = false;
                        }

                        isCompatible = isCompatible !== false && compareNodeNames(curVFromNodeChild, curToNodeChild) === true;

                        if (isCompatible === true) {
                            // We found compatible DOM elements so transform
                            // the current "from" node to match the current
                            // target DOM node.
                            morphEl(curFromNodeChild, curVFromNodeChild, curToNodeChild, component, curToNodeKey);
                        }

                    } else if (curFromNodeType === TEXT_NODE || curFromNodeType === COMMENT_NODE) {
                        // Both nodes being compared are Text or Comment nodes
                        isCompatible = true;
                        // Simply update nodeValue on the original node to
                        // change the text value
                        curFromNodeChild.nodeValue = curToNodeChild.___nodeValue;
                    }
                }

                if (isCompatible === true) {
                    // Advance both the "to" child and the "from" child since we found a match
                    curToNodeChild = toNextSibling;
                    curFromNodeChild = fromNextSibling;
                    continue outer;
                }

                if (curFromNodeKey) {
                    if (globalComponentsContext.___preservedEls[curFromNodeKey] === undefined) {
                        detachNode(curFromNodeChild, parentFromNode, componentForNode);
                    }
                } else {
                    detachNode(curFromNodeChild, parentFromNode, componentForNode);
                }

                curFromNodeChild = fromNextSibling;
            } // END: while (curFromNodeChild)

            // If we got this far then we did not find a candidate match for
            // our "to node" and we exhausted all of the children "from"
            // nodes. Therefore, we will just append the current "to" node
            // to the end
            insertVirtualNodeBefore(curToNodeChild, curToNodeKey, curFromNodeChild, parentFromNode, componentForNode);

            curToNodeChild = toNextSibling;
            curFromNodeChild = fromNextSibling;
        }

        // We have processed all of the "to nodes". If curFromNodeChild is
        // non-null then we still have some from nodes left over that need
        // to be removed
        while (curFromNodeChild && (endNode === null || curFromNodeChild !== endNode)) {
            fromNextSibling = curFromNodeChild.nextSibling;

            if ((fromComponent = curFromNodeChild.___markoComponent)) {
                if (globalComponentsContext.___renderedComponentsById[fromComponent.id]) {
                    // Skip over this component since it was rendered in the target VDOM
                    // and will be moved into place later
                    curFromNodeChild = fromComponent.___endNode.nextSibling;
                    continue;
                }
            }

            detachNode(curFromNodeChild, parentFromNode, component);

            curFromNodeChild = fromNextSibling;
        }
    }

    function morphEl(fromEl, vFromEl, toEl, component, toElKey) {
        var nodeName = toEl.___nodeName;

        if (isRerenderInBrowser === true && toElKey) {
            component.___keyedElements[toElKey] = fromEl;
        }

        var constId = toEl.___constId;
        if (constId !== undefined && vFromEl.___constId === constId) {
            return;
        }

        morphAttrs(fromEl, vFromEl, toEl);

        if (toElKey && globalComponentsContext.___preservedElBodies[toElKey] === true) {
            // Don't morph the children since they are preserved
            return;
        }

        if (nodeName !== 'TEXTAREA') {
            morphChildren(fromEl, fromEl.firstChild, null, toEl, component);
        }

        var specialElHandler = specialElHandlers[nodeName];
        if (specialElHandler !== undefined) {
            specialElHandler(fromEl, toEl);
        }
    } // END: morphEl(...)

    morphChildren(parentNode, startNode, endNode, toNode);

    detachedNodes.forEach(function(node) {
        var detachedFromComponent = node.___markoDetached;

        if (detachedFromComponent !== undefined) {
            node.___markoDetached = undefined;

            var componentToDestroy = node.___markoComponent;
            if (componentToDestroy) {
                componentToDestroy.destroy();
            } else {
                destroyNodeRecursive(node, detachedFromComponent !== true && detachedFromComponent);

                if (eventDelegation.___handleNodeDetach(node) != false) {
                     node.parentNode.removeChild(node);
                }
            }
        }

    });
}

module.exports = morphdom;

});
$_mod.def("/marko$4.5.3/src/components/Component", function(require, exports, module, __filename, __dirname) { 'use strict';
/* jshint newcap:false */

var domInsert = require('/marko$4.5.3/src/runtime/dom-insert'/*'../runtime/dom-insert'*/);
var defaultCreateOut = require('/marko$4.5.3/src/runtime/createOut'/*'../runtime/createOut'*/);
var getComponentsContext = require('/marko$4.5.3/src/components/ComponentsContext'/*'./ComponentsContext'*/).___getComponentsContext;
var componentsUtil = require('/marko$4.5.3/src/components/util-browser'/*'./util'*/);
var componentLookup = componentsUtil.___componentLookup;
var emitLifecycleEvent = componentsUtil.___emitLifecycleEvent;
var destroyNodeRecursive = componentsUtil.___destroyNodeRecursive;
var EventEmitter = require('/events-light$1.0.5/src/index'/*'events-light'*/);
var RenderResult = require('/marko$4.5.3/src/runtime/RenderResult'/*'../runtime/RenderResult'*/);
var SubscriptionTracker = require('/listener-tracker$2.0.0/lib/listener-tracker'/*'listener-tracker'*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*'raptor-util/inherit'*/);
var updateManager = require('/marko$4.5.3/src/components/update-manager'/*'./update-manager'*/);
var morphdom = require('/marko$4.5.3/src/morphdom/index'/*'../morphdom'*/);
var eventDelegation = require('/marko$4.5.3/src/components/event-delegation'/*'./event-delegation'*/);

var slice = Array.prototype.slice;

var COMPONENT_SUBSCRIBE_TO_OPTIONS;
var NON_COMPONENT_SUBSCRIBE_TO_OPTIONS = {
    addDestroyListener: false
};

var emit = EventEmitter.prototype.emit;

function removeListener(removeEventListenerHandle) {
    removeEventListenerHandle();
}

function handleCustomEventWithMethodListener(component, targetMethodName, args, extraArgs) {
    // Remove the "eventType" argument
    args.push(component);

    if (extraArgs) {
        args = extraArgs.concat(args);
    }


    var targetComponent = componentLookup[component.___scope];
    var targetMethod = targetComponent[targetMethodName];
    if (!targetMethod) {
        throw Error('Method not found: ' + targetMethodName);
    }

    targetMethod.apply(targetComponent, args);
}

function resolveKeyHelper(key, index) {
    return index ? key + '_' + index : key;
}

function resolveComponentIdHelper(component, key, index) {
    return component.id + '-' + resolveKeyHelper(key, index);
}

/**
 * This method is used to process "update_<stateName>" handler functions.
 * If all of the modified state properties have a user provided update handler
 * then a rerender will be bypassed and, instead, the DOM will be updated
 * looping over and invoking the custom update handlers.
 * @return {boolean} Returns true if if the DOM was updated. False, otherwise.
 */
function processUpdateHandlers(component, stateChanges, oldState) {
    var handlerMethod;
    var handlers;

    for (var propName in stateChanges) {
        if (stateChanges.hasOwnProperty(propName)) {
            var handlerMethodName = 'update_' + propName;

            handlerMethod = component[handlerMethodName];
            if (handlerMethod) {
                (handlers || (handlers=[])).push([propName, handlerMethod]);
            } else {
                // This state change does not have a state handler so return false
                // to force a rerender
                return;
            }
        }
    }

    // If we got here then all of the changed state properties have
    // an update handler or there are no state properties that actually
    // changed.
    if (handlers) {
        // Otherwise, there are handlers for all of the changed properties
        // so apply the updates using those handlers

        handlers.forEach(function(handler, i) {
            var propertyName = handler[0];
            handlerMethod = handler[1];

            var newValue = stateChanges[propertyName];
            var oldValue = oldState[propertyName];
            handlerMethod.call(component, newValue, oldValue);
        });

        emitLifecycleEvent(component, 'update');

        component.___reset();
    }

    return true;
}

function checkInputChanged(existingComponent, oldInput, newInput) {
    if (oldInput != newInput) {
        if (oldInput == null || newInput == null) {
            return true;
        }

        var oldKeys = Object.keys(oldInput);
        var newKeys = Object.keys(newInput);
        var len = oldKeys.length;
        if (len !== newKeys.length) {
            return true;
        }

        for (var i=0; i<len; i++) {
            var key = oldKeys[i];
            if (oldInput[key] !== newInput[key]) {
                return true;
            }
        }
    }

    return false;
}

function getNodes(component) {
    var nodes = [];
    component.___forEachNode(nodes.push.bind(nodes));
    return nodes;
}

var componentProto;

/**
 * Base component type.
 *
 * NOTE: Any methods that are prefixed with an underscore should be considered private!
 */
function Component(id) {
    EventEmitter.call(this);
    this.id = id;
    this.___state = null;
    this.___startNode = null;
    this.___endNode = null;
    this.___subscriptions = null;
    this.___domEventListenerHandles = null;
    this.___bubblingDomEvents = null; // Used to keep track of bubbling DOM events for components rendered on the server
    this.___customEvents = null;
    this.___scope = null;
    this.___renderInput = null;
    this.___input = undefined;
    this.___mounted = false;
    this.___global = undefined;

    this.___destroyed = false;
    this.___updateQueued = false;
    this.___dirty = false;
    this.___settingInput = false;

    this.___document = undefined;

    this.___keyedElements = {};
    this.___keySequence = undefined;
}

Component.prototype = componentProto = {
    ___isComponent: true,

    subscribeTo: function(target) {
        if (!target) {
            throw TypeError();
        }

        var subscriptions = this.___subscriptions || (this.___subscriptions = new SubscriptionTracker());

        var subscribeToOptions = target.___isComponent ?
            COMPONENT_SUBSCRIBE_TO_OPTIONS :
            NON_COMPONENT_SUBSCRIBE_TO_OPTIONS;

        return subscriptions.subscribeTo(target, subscribeToOptions);
    },

    emit: function(eventType) {
        var customEvents = this.___customEvents;
        var target;

        if (customEvents && (target = customEvents[eventType])) {
            var targetMethodName = target[0];
            var extraArgs = target[1];
            var args = slice.call(arguments, 1);

            handleCustomEventWithMethodListener(this, targetMethodName, args, extraArgs);
        }

        if (this.listenerCount(eventType)) {
            return emit.apply(this, arguments);
        }
    },
    getElId: function (key, index) {
        return resolveComponentIdHelper(this, key, index);
    },
    getEl: function (key, index) {
        if (key) {
            return this.___keyedElements[resolveKeyHelper(key, index)];
        } else {
            return this.___startNode;
        }
    },
    getEls: function(key) {
        key = key + '[]';

        var els = [];
        var i = 0;
        var el;
        while((el = this.getEl(key, i))) {
            els.push(el);
            i++;
        }
        return els;
    },
    getComponent: function(key, index) {
        return componentLookup[resolveComponentIdHelper(this, key, index)];
    },
    getComponents: function(key) {
        key = key + '[]';

        var components = [];
        var i = 0;
        var component;
        while((component = componentLookup[resolveComponentIdHelper(this, key, i)])) {
            components.push(component);
            i++;
        }
        return components;
    },
    destroy: function() {
        if (this.___destroyed) {
            return;
        }

        var nodes = getNodes(this);

        this.___destroyShallow();

        nodes.forEach(function(node) {
            destroyNodeRecursive(node);

            if (eventDelegation.___handleNodeDetach(node) != false) {
                 node.parentNode.removeChild(node);
            }
        });

        delete componentLookup[this.id];
    },

    ___destroyShallow: function() {
        if (this.___destroyed) {
            return;
        }

        emitLifecycleEvent(this, 'destroy');
        this.___destroyed = true;

        this.___startNode.___markoComponent = undefined;

        this.___startNode = this.___endNode = null;

        // Unsubscribe from all DOM events
        this.___removeDOMEventListeners();

        var subscriptions = this.___subscriptions;
        if (subscriptions) {
            subscriptions.removeAllListeners();
            this.___subscriptions = null;
        }
    },

    isDestroyed: function() {
        return this.___destroyed;
    },
    get state() {
        return this.___state;
    },
    set state(newState) {
        var state = this.___state;
        if (!state && !newState) {
            return;
        }

        if (!state) {
            state = this.___state = new this.___State(this);
        }

        state.___replace(newState || {});

        if (state.___dirty) {
            this.___queueUpdate();
        }

        if (!newState) {
            this.___state = null;
        }
    },
    setState: function(name, value) {
        var state = this.___state;

        if (typeof name == 'object') {
            // Merge in the new state with the old state
            var newState = name;
            for (var k in newState) {
                if (newState.hasOwnProperty(k)) {
                    state.___set(k, newState[k], true /* ensure:true */);
                }
            }
        } else {
            state.___set(name, value, true /* ensure:true */);
        }
    },

    setStateDirty: function(name, value) {
        var state = this.___state;

        if (arguments.length == 1) {
            value = state[name];
        }

        state.___set(name, value, true /* ensure:true */, true /* forceDirty:true */);
    },

    replaceState: function(newState) {
        this.___state.___replace(newState);
    },

    get input() {
        return this.___input;
    },
    set input(newInput) {
        if (this.___settingInput) {
            this.___input = newInput;
        } else {
            this.___setInput(newInput);
        }
    },

    ___setInput: function(newInput, onInput, out) {
        onInput = onInput || this.onInput;
        var updatedInput;

        var oldInput = this.___input;
        this.___input = undefined;

        if (onInput) {
            // We need to set a flag to preview `this.input = foo` inside
            // onInput causing infinite recursion
            this.___settingInput = true;
            updatedInput = onInput.call(this, newInput || {}, out);
            this.___settingInput = false;
        }

        newInput = this.___renderInput = updatedInput || newInput;

        if ((this.___dirty = checkInputChanged(this, oldInput, newInput))) {
            this.___queueUpdate();
        }

        if (this.___input === undefined) {
            this.___input = newInput;
            if (newInput && newInput.$global) {
                this.___global = newInput.$global;
            }
        }

        return newInput;
    },

    forceUpdate: function() {
        this.___dirty = true;
        this.___queueUpdate();
    },

    ___queueUpdate: function() {
        if (!this.___updateQueued) {
            this.___updateQueued = true;
            updateManager.___queueComponentUpdate(this);
        }
    },

    update: function() {
        if (this.___destroyed === true || this.___isDirty === false) {
            return;
        }

        var input = this.___input;
        var state = this.___state;

        if (this.___dirty === false && state !== null && state.___dirty === true) {
            if (processUpdateHandlers(this, state.___changes, state.___old, state)) {
                state.___dirty = false;
            }
        }

        if (this.___isDirty === true) {
            // The UI component is still dirty after process state handlers
            // then we should rerender

            if (this.shouldUpdate(input, state) !== false) {
                this.___rerender(false);
            }
        }

        this.___reset();
    },


    get ___isDirty() {
        return this.___dirty === true || (this.___state !== null && this.___state.___dirty === true);
    },

    ___reset: function() {
        this.___dirty = false;
        this.___updateQueued = false;
        this.___renderInput = null;
        var state = this.___state;
        if (state) {
            state.___reset();
        }
    },

    shouldUpdate: function(newState, newProps) {
        return true;
    },

    ___emitLifecycleEvent: function(eventType, eventArg1, eventArg2) {
        emitLifecycleEvent(this, eventType, eventArg1, eventArg2);
    },

    ___rerender: function(isRerenderInBrowser) {
        var self = this;
        var renderer = self.___renderer;

        if (!renderer) {
            throw TypeError();
        }

        var startNode = this.___startNode;
        var endNodeNextSibling = this.___endNode.nextSibling;

        var doc = self.___document;
        var input = this.___renderInput || this.___input;
        var globalData = this.___global;

        updateManager.___batchUpdate(function() {
            var createOut = renderer.createOut || defaultCreateOut;
            var out = createOut(globalData);
            out.sync();
            out.___document = self.___document;

            var componentsContext = getComponentsContext(out);
            var globalComponentsContext = componentsContext.___globalContext;
            globalComponentsContext.___rerenderComponent = self;
            globalComponentsContext.___isRerenderInBrowser = isRerenderInBrowser;

            renderer(input, out);

            var result = new RenderResult(out);

            var targetNode = out.___getOutput();

            morphdom(
                startNode.parentNode,
                startNode,
                endNodeNextSibling,
                targetNode,
                doc,
                componentsContext);

            result.afterInsert(doc);
        });

        this.___reset();
    },

    ___detach: function() {
        var fragment = this.___document.createDocumentFragment();
        this.___forEachNode(fragment.appendChild.bind(fragment));
        return fragment;
    },

    ___forEachNode: function(callback) {
        var currentNode = this.___startNode;
        var endNode = this.___endNode;

        for(;;) {
            var nextSibling = currentNode.nextSibling;
            callback(currentNode);
            if (currentNode == endNode) {
                break;
            }
            currentNode = nextSibling;
        }
    },

    ___removeDOMEventListeners: function() {
        var eventListenerHandles = this.___domEventListenerHandles;
        if (eventListenerHandles) {
            eventListenerHandles.forEach(removeListener);
            this.___domEventListenerHandles = null;
        }
    },

    get ___rawState() {
        var state = this.___state;
        return state && state.___raw;
    },

    ___setCustomEvents: function(customEvents, scope) {
        var finalCustomEvents = this.___customEvents = {};
        this.___scope = scope;

        customEvents.forEach(function(customEvent) {
            var eventType = customEvent[0];
            var targetMethodName = customEvent[1];
            var extraArgs = customEvent[2];

            finalCustomEvents[eventType] = [targetMethodName, extraArgs];
        });
    },

    get el() {
        return this.___startNode;
    },

    get els() {
        return getNodes(this);
    }
};

componentProto.elId = componentProto.getElId;
componentProto.___update = componentProto.update;
componentProto.___destroy = componentProto.destroy;

// Add all of the following DOM methods to Component.prototype:
// - appendTo(referenceEl)
// - replace(referenceEl)
// - replaceChildrenOf(referenceEl)
// - insertBefore(referenceEl)
// - insertAfter(referenceEl)
// - prependTo(referenceEl)
domInsert(
    componentProto,
    function getEl(component) {
        return component.___detach();
    },
    function afterInsert(component) {
        return component;
    });

inherit(Component, EventEmitter);

module.exports = Component;

});
$_mod.def("/marko$4.5.3/src/components/defineComponent", function(require, exports, module, __filename, __dirname) { 'use strict';
/* jshint newcap:false */

var BaseState = require('/marko$4.5.3/src/components/State'/*'./State'*/);
var BaseComponent = require('/marko$4.5.3/src/components/Component'/*'./Component'*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*'raptor-util/inherit'*/);

module.exports = function defineComponent(def, renderer) {
    if (def.___isComponent) {
        return def;
    }

    var ComponentClass = function() {};
    var proto;

    var type = typeof def;

    if (type == 'function') {
        proto = def.prototype;
    } else if (type == 'object') {
        proto = def;
    } else {
        throw TypeError();
    }

    ComponentClass.prototype = proto;

    // We don't use the constructor provided by the user
    // since we don't invoke their constructor until
    // we have had a chance to do our own initialization.
    // Instead, we store their constructor in the "initComponent"
    // property and that method gets called later inside
    // init-components-browser.js
    function Component(id) {
        BaseComponent.call(this, id);
    }

    if (!proto.___isComponent) {
        // Inherit from Component if they didn't already
        inherit(ComponentClass, BaseComponent);
    }

    // The same prototype will be used by our constructor after
    // we he have set up the prototype chain using the inherit function
    proto = Component.prototype = ComponentClass.prototype;

    // proto.constructor = def.constructor = Component;

    // Set a flag on the constructor function to make it clear this is
    // a component so that we can short-circuit this work later
    Component.___isComponent = true;

    function State(component) { BaseState.call(this, component); }
    inherit(State, BaseState);
    proto.___State = State;
    proto.___renderer = renderer;

    return Component;
};

});
$_mod.def("/marko$4.5.3/src/components/registry-browser", function(require, exports, module, __filename, __dirname) { var loadComponent = require('/marko$4.5.3/src/components/loadComponent-dynamic'/*'./loadComponent'*/);
var defineComponent = require('/marko$4.5.3/src/components/defineComponent'/*'./defineComponent'*/);

var registered = {};
var loaded = {};
var componentTypes = {};

function register(typeName, def) {
    // We do this to kick off registering of nested components
    // but we don't use the return value just yet since there
    // is a good chance that it resulted in a circular dependency
    def();

    registered[typeName] = def;
    delete loaded[typeName];
    delete componentTypes[typeName];
    return typeName;
}

function load(typeName) {
    var target = loaded[typeName];
    if (!target) {
        target = registered[typeName];

        if (target) {
            target = target();
        } else {
            target = loadComponent(typeName); // Assume the typeName has been fully resolved already
        }

        if (!target) {
            throw Error('Not found: ' + typeName);
        }

        loaded[typeName] = target;
    }

    return target;
}

function getComponentClass(typeName) {
    var ComponentClass = componentTypes[typeName];

    if (ComponentClass) {
        return ComponentClass;
    }

    ComponentClass = load(typeName);

    ComponentClass = ComponentClass.Component || ComponentClass;

    if (!ComponentClass.___isComponent) {
        ComponentClass = defineComponent(ComponentClass, ComponentClass.renderer);
    }

    // Make the component "type" accessible on each component instance
    ComponentClass.prototype.___type = typeName;

    componentTypes[typeName] = ComponentClass;

    return ComponentClass;
}

function createComponent(typeName, id) {
    var ComponentClass = getComponentClass(typeName);
    return new ComponentClass(id);
}

exports.___register = register;
exports.___createComponent = createComponent;

});
$_mod.def("/marko$4.5.3/src/components/init-components-browser", function(require, exports, module, __filename, __dirname) { 'use strict';
var warp10Finalize = require('/warp10$1.3.6/finalize'/*'warp10/finalize'*/);
var eventDelegation = require('/marko$4.5.3/src/components/event-delegation'/*'./event-delegation'*/);
var win = window;
var defaultDocument = document;
var componentsUtil = require('/marko$4.5.3/src/components/util-browser'/*'./util'*/);
var componentLookup = componentsUtil.___componentLookup;
var ComponentDef = require('/marko$4.5.3/src/components/ComponentDef'/*'./ComponentDef'*/);
var registry = require('/marko$4.5.3/src/components/registry-browser'/*'./registry'*/);
var serverRenderedGlobals = {};
var serverComponentStartNodes = {};
var serverComponentEndNodes = {};
var keyedElementsByComponentId = {};

var FLAG_WILL_RERENDER_IN_BROWSER = 1;
var FLAG_HAS_BODY_EL = 2;
var FLAG_HAS_HEAD_EL = 4;

function indexServerComponentBoundaries(node) {
    var componentId;

    node = node.firstChild;
    while(node) {
        if (node.nodeType === 8) { // Comment node
            var commentValue = node.nodeValue;
            if (commentValue[0] === 'M') {
                componentId = commentValue.substring(2);

                var firstChar = commentValue[1];

                if (firstChar === '/') {
                    serverComponentEndNodes[componentId] = node;
                } else if (firstChar === '#') {
                    serverComponentStartNodes[componentId] = node;
                    var endValue = 'M/' + componentId;
                    while((node = node.nextSibling) && node.nodeValue !== endValue) {}
                    continue;
                } else if (firstChar === '^'){
                    serverComponentStartNodes[componentId] = node;
                }
            }
        } else if (node.nodeType === 1) { // HTML element node
            var markoKey = node.getAttribute('data-marko-key');
            if (markoKey) {
                var separatorIndex = markoKey.indexOf(' ');
                componentId = markoKey.substring(separatorIndex+1);
                markoKey = markoKey.substring(0, separatorIndex);
                var keyedElements = keyedElementsByComponentId[componentId] || (keyedElementsByComponentId[componentId] = {});
                keyedElements[markoKey] = node;
            }
            indexServerComponentBoundaries(node);
        }

        node = node.nextSibling;
    }

}

function invokeComponentEventHandler(component, targetMethodName, args) {
    var method = component[targetMethodName];
    if (!method) {
        throw Error('Method not found: ' + targetMethodName);
    }

    method.apply(component, args);
}

function addEventListenerHelper(el, eventType, listener) {
    el.addEventListener(eventType, listener, false);
    return function remove() {
        el.removeEventListener(eventType, listener);
    };
}

function addDOMEventListeners(component, el, eventType, targetMethodName, extraArgs, handles) {
    var removeListener = addEventListenerHelper(el, eventType, function(event) {
        var args = [event, el];
        if (extraArgs) {
            args = extraArgs.concat(args);
        }

        invokeComponentEventHandler(component, targetMethodName, args);
    });
    handles.push(removeListener);
}

function initComponent(componentDef, doc) {
    var component = componentDef.___component;

    if (!component || !component.___isComponent) {
        return; // legacy
    }

    component.___reset();
    component.___document = doc;

    var isExisting = componentDef.___isExisting;
    var id = component.id;

    componentLookup[id] = component;

    if (componentDef.___flags & FLAG_WILL_RERENDER_IN_BROWSER) {
        component.___rerender(true);
        return;
    }

    if (isExisting) {
        component.___removeDOMEventListeners();
    }

    var domEvents = componentDef.___domEvents;
    if (domEvents) {
        var eventListenerHandles = [];

        domEvents.forEach(function(domEventArgs) {
            // The event mapping is for a direct DOM event (not a custom event and not for bubblign dom events)

            var eventType = domEventArgs[0];
            var targetMethodName = domEventArgs[1];
            var eventEl = component.___keyedElements[domEventArgs[2]];
            var extraArgs = domEventArgs[3];

            addDOMEventListeners(component, eventEl, eventType, targetMethodName, extraArgs, eventListenerHandles);
        });

        if (eventListenerHandles.length) {
            component.___domEventListenerHandles = eventListenerHandles;
        }
    }

    if (component.___mounted) {
        component.___emitLifecycleEvent('update');
    } else {
        component.___mounted = true;
        component.___emitLifecycleEvent('mount');
    }
}

/**
 * This method is used to initialized components associated with UI components
 * rendered in the browser. While rendering UI components a "components context"
 * is added to the rendering context to keep up with which components are rendered.
 * When ready, the components can then be initialized by walking the component tree
 * in the components context (nested components are initialized before ancestor components).
 * @param  {Array<marko-components/lib/ComponentDef>} componentDefs An array of ComponentDef instances
 */
function initClientRendered(componentDefs, doc) {
    // Ensure that event handlers to handle delegating events are
    // always attached before initializing any components
    eventDelegation.___init(doc);

    doc = doc || defaultDocument;
    for (var i=componentDefs.length-1; i>=0; i--) {
        var componentDef = componentDefs[i];
        initComponent(
            componentDef,
            doc);
    }
}

/**
 * This method initializes all components that were rendered on the server by iterating over all
 * of the component IDs.
 */
function initServerRendered(renderedComponents, doc) {
    if (!renderedComponents) {
        renderedComponents = win.$components;

        if (renderedComponents && renderedComponents.forEach) {
            renderedComponents.forEach(function(renderedComponent) {
                initServerRendered(renderedComponent, doc);
            });
        }

        win.$components = {
            concat: initServerRendered
        };

        return;
    }

    doc = doc || defaultDocument;

    // Ensure that event handlers to handle delegating events are
    // always attached before initializing any components
    eventDelegation.___init(doc);

    renderedComponents = warp10Finalize(renderedComponents);

    var componentDefs = renderedComponents.w;
    var typesArray = renderedComponents.t;
    var globals = window.$MG;
    if (globals) {
        serverRenderedGlobals = warp10Finalize(globals);
        delete window.$MG;
    }

    componentDefs.forEach(function(componentDef) {
        componentDef = ComponentDef.___deserialize(componentDef, typesArray, serverRenderedGlobals, registry);
        var componentId = componentDef.id;
        var component = componentDef.___component;

        var startNode;
        var endNode;
        var flags = componentDef.___flags;
        if ((flags & 6) === 6) {
            startNode = document.head;
            endNode = document.body;
        } else if (flags & FLAG_HAS_BODY_EL) {
            startNode = endNode = document.body;
        } else if (flags & FLAG_HAS_HEAD_EL) {
            startNode = endNode = document.head;
        } else {
            var startNodeComment = serverComponentStartNodes[componentId];
            if (!startNodeComment) {
                indexServerComponentBoundaries(doc);
                startNodeComment = serverComponentStartNodes[componentId];
            }
            var endNodeComment = serverComponentEndNodes[componentId];

            startNode = startNodeComment.nextSibling;

            if (startNode === endNodeComment) {
                // Component has no output nodes so just mount to the start comment node
                // and we will remove the end comment node
                startNode = endNode = startNodeComment;
            } else {
                startNodeComment.parentNode.removeChild(startNodeComment);

                if (startNode.parentNode === document) {
                    endNode = startNode = document.documentElement;
                } else {
                    // Remove the start and end comment nodes and use the inner nodes
                    // as the boundary
                    endNode = endNodeComment.previousSibling;
                }
            }

            if (endNodeComment) {
                endNodeComment.parentNode.removeChild(endNodeComment);
            }
        }

        component.___keyedElements = keyedElementsByComponentId[componentId] || {};
        component.___startNode = startNode;
        component.___endNode = endNode;

        startNode.___markoComponent = component;

        delete keyedElementsByComponentId[componentId];

        // Mark the start node so that we know we need to skip past this
        // node when matching up children
        startNode.___startNode = true;

        // Mark the end node so that when we attempt to find boundaries
        // for nested UI components we don't accidentally go outside the boundary
        // of the parent component
        endNode.___endNode = true;

        initComponent(componentDef, doc || defaultDocument);
    });
}

exports.___initClientRendered = initClientRendered;
exports.___initServerRendered = initServerRendered;

});
$_mod.def("/marko$4.5.3/src/components/boot", function(require, exports, module, __filename, __dirname) { require('/marko$4.5.3/src/components/init-components-browser'/*'./init-components'*/).___initServerRendered();
});
$_mod.run("/marko$4.5.3/src/components/boot");
$_mod.def("/marko$4.5.3/src/components/util-browser", function(require, exports, module, __filename, __dirname) { 
var markoUID = window.$MUID || (window.$MUID = { i: 0 });
var runtimeId = markoUID.i++;

var componentLookup = {};

var defaultDocument = document;
var EMPTY_OBJECT = {};

function getComponentForEl(el, doc) {
    if (el) {
        var node = typeof el == 'string' ? (doc || defaultDocument).getElementById(el) : el;
        if (node) {
            return node.___markoComponent;
        }
    }
}

var lifecycleEventMethods = {};

[
    'create',
    'render',
    'update',
    'mount',
    'destroy'
].forEach(function(eventName) {
    lifecycleEventMethods[eventName] = 'on' + eventName[0].toUpperCase() + eventName.substring(1);
});

/**
 * This method handles invoking a component's event handler method
 * (if present) while also emitting the event through
 * the standard EventEmitter.prototype.emit method.
 *
 * Special events and their corresponding handler methods
 * include the following:
 *
 * beforeDestroy --> onBeforeDestroy
 * destroy       --> onDestroy
 * beforeUpdate  --> onBeforeUpdate
 * update        --> onUpdate
 * render        --> onRender
 */
function emitLifecycleEvent(component, eventType, eventArg1, eventArg2) {
    var listenerMethod = component[lifecycleEventMethods[eventType]];

    if (listenerMethod !== undefined) {
        listenerMethod.call(component, eventArg1, eventArg2);
    }

    component.emit(eventType, eventArg1, eventArg2);
}

function destroyComponentForNode(node) {
    var componentToDestroy = node.___markoComponent;
    if (componentToDestroy) {
        componentToDestroy.___destroyShallow();
        delete componentLookup[componentToDestroy.id];
    }
}
function destroyNodeRecursive(node, component) {
    if (node.nodeType === 1) {
        var key;

        if (component && (key = node.___markoKey)) {
            if (node === component.___keyedElements[key]) {
                delete component.___keyedElements[key];
            }
        }

        var curChild = node.firstChild;
        while(curChild) {
            destroyComponentForNode(curChild);
            destroyNodeRecursive(curChild, component);
            curChild = curChild.nextSibling;
        }
    }
}

function nextComponentId() {
    // Each component will get an ID that is unique across all loaded
    // marko runtimes. This allows multiple instances of marko to be
    // loaded in the same window and they should all place nice
    // together
    return 'b' + (markoUID.i++);
}

function nextComponentIdProvider() {
    return nextComponentId;
}

function attachBubblingEvent(componentDef, handlerMethodName, extraArgs) {
    if (handlerMethodName) {
        var componentId = componentDef.id;
        if (extraArgs) {
            return [handlerMethodName, componentId, extraArgs];
        } else {
            return [handlerMethodName, componentId];
        }
    }
}

function getMarkoPropsFromEl(el) {
    var vElement = el.___markoVElement;
    var virtualProps;

    if (vElement) {
        virtualProps = vElement.___properties;
    } else {
        virtualProps = el.___markoVProps;
        if (!virtualProps) {
            virtualProps = el.getAttribute('data-marko');
            el.___markoVProps = virtualProps = virtualProps ? JSON.parse(virtualProps) : EMPTY_OBJECT;
        }
    }

    return virtualProps;
}

exports.___runtimeId = runtimeId;
exports.___componentLookup = componentLookup;
exports.___getComponentForEl = getComponentForEl;
exports.___emitLifecycleEvent = emitLifecycleEvent;
exports.___destroyComponentForNode = destroyComponentForNode;
exports.___destroyNodeRecursive = destroyNodeRecursive;
exports.___nextComponentIdProvider = nextComponentIdProvider;
exports.___attachBubblingEvent = attachBubblingEvent;
exports.___getMarkoPropsFromEl = getMarkoPropsFromEl;

});
$_mod.def("/marko$4.5.3/src/runtime/dom-insert", function(require, exports, module, __filename, __dirname) { var extend = require('/raptor-util$3.2.0/extend'/*'raptor-util/extend'*/);
var componentsUtil = require('/marko$4.5.3/src/components/util-browser'/*'../components/util'*/);
var destroyComponentForNode = componentsUtil.___destroyComponentForNode;
var destroyNodeRecursive = componentsUtil.___destroyNodeRecursive;

function resolveEl(el) {
    if (typeof el == 'string') {
        var elId = el;
        el = document.getElementById(elId);
        if (!el) {
            throw Error('Not found: ' + elId);
        }
    }
    return el;
}

function beforeRemove(referenceEl) {
    destroyNodeRecursive(referenceEl);
    destroyComponentForNode(referenceEl);
}

module.exports = function(target, getEl, afterInsert) {
    extend(target, {
        appendTo: function(referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            referenceEl.appendChild(el);
            return afterInsert(this, referenceEl);
        },
        prependTo: function(referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            referenceEl.insertBefore(el, referenceEl.firstChild || null);
            return afterInsert(this, referenceEl);
        },
        replace: function(referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            beforeRemove(referenceEl);
            referenceEl.parentNode.replaceChild(el, referenceEl);
            return afterInsert(this, referenceEl);
        },
        replaceChildrenOf: function(referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);

            var curChild = referenceEl.firstChild;
            while(curChild) {
                var nextSibling = curChild.nextSibling; // Just in case the DOM changes while removing
                beforeRemove(curChild);
                curChild = nextSibling;
            }

            referenceEl.innerHTML = '';
            referenceEl.appendChild(el);
            return afterInsert(this, referenceEl);
        },
        insertBefore: function(referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            referenceEl.parentNode.insertBefore(el, referenceEl);
            return afterInsert(this, referenceEl);
        },
        insertAfter: function(referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            el = el;
            var nextSibling = referenceEl.nextSibling;
            var parentNode = referenceEl.parentNode;
            if (nextSibling) {
                parentNode.insertBefore(el, nextSibling);
            } else {
                parentNode.appendChild(el);
            }
            return afterInsert(this, referenceEl);
        }
    });
};

});
$_mod.def("/marko$4.5.3/src/runtime/RenderResult", function(require, exports, module, __filename, __dirname) { var domInsert = require('/marko$4.5.3/src/runtime/dom-insert'/*'./dom-insert'*/);

function getComponentDefs(result) {
    var componentDefs = result.___components;

    if (!componentDefs) {
        throw Error('No component');
    }
    return componentDefs;
}

function RenderResult(out) {
   this.out = this.___out = out;
   this.___components = undefined;
}

module.exports = RenderResult;

var proto = RenderResult.prototype = {
    getComponent: function() {
        return this.getComponents()[0];
    },
    getComponents: function(selector) {
        if (this.___components === undefined) {
            throw Error('Not added to DOM');
        }

        var componentDefs = getComponentDefs(this);

        var components = [];

        componentDefs.forEach(function(componentDef) {
            var component = componentDef.___component;
            if (!selector || selector(component)) {
                components.push(component);
            }
        });

        return components;
    },

    afterInsert: function(doc) {
        var out = this.___out;
        var componentsContext = out.___components;
        if (componentsContext) {
            this.___components = componentsContext.___initComponents(doc);
        } else {
            this.___components = null;
        }

        return this;
    },
    getNode: function(doc) {
        return this.___out.___getNode(doc);
    },
    getOutput: function() {
        return this.___out.___getOutput();
    },
    toString: function() {
        return this.___out.toString();
    },
    document: typeof document != 'undefined' && document
};

// Add all of the following DOM methods to Component.prototype:
// - appendTo(referenceEl)
// - replace(referenceEl)
// - replaceChildrenOf(referenceEl)
// - insertBefore(referenceEl)
// - insertAfter(referenceEl)
// - prependTo(referenceEl)
domInsert(
    proto,
    function getEl(renderResult, referenceEl) {
        return renderResult.getNode(referenceEl.ownerDocument);
    },
    function afterInsert(renderResult, referenceEl) {
        var isShadow = typeof ShadowRoot === 'function' && referenceEl instanceof ShadowRoot;
        return renderResult.afterInsert(isShadow ? referenceEl : referenceEl.ownerDocument);
    });

});
$_mod.def("/marko$4.5.3/src/runtime/vdom/AsyncVDOMBuilder", function(require, exports, module, __filename, __dirname) { var EventEmitter = require('/events-light$1.0.5/src/index'/*'events-light'*/);
var vdom = require('/marko$4.5.3/src/runtime/vdom/vdom'/*'./vdom'*/);
var VElement = vdom.___VElement;
var VDocumentFragment = vdom.___VDocumentFragment;
var VComment = vdom.___VComment;
var VText = vdom.___VText;
var VComponent = vdom.___VComponent;
var virtualizeHTML = vdom.___virtualizeHTML;
var RenderResult = require('/marko$4.5.3/src/runtime/RenderResult'/*'../RenderResult'*/);
var defaultDocument = vdom.___defaultDocument;
var morphdom = require('/marko$4.5.3/src/morphdom/index'/*'../../morphdom'*/);

var EVENT_UPDATE = 'update';
var EVENT_FINISH = 'finish';

function State(tree) {

    this.___events = new EventEmitter();
    this.___tree = tree;
    this.___finished = false;
}

function AsyncVDOMBuilder(globalData, parentNode, parentOut) {
    if (!parentNode) {
        parentNode = new VDocumentFragment();
    }

    var state;

    if (parentOut) {
        state = parentOut.___state;
    } else {
        state = new State(parentNode);
    }

    this.___remaining = 1;
    this.___lastCount = 0;
    this.___last = null;
    this.___parentOut = parentOut;


    this.data = {};
    this.___state = state;
    this.___parent = parentNode;
    this.global = globalData || {};
    this.___stack = [parentNode];
    this.___sync = false;
    this.___vnode = undefined;
    this.___components = null;

    this.___assignedComponentDef = null;
    this.___assignedKey = null;
    this.___assignedCustomEvents = null;
}

var proto = AsyncVDOMBuilder.prototype = {
    ___isOut: true,
    ___document: defaultDocument,

    bc: function(component) {
        var vComponent = new VComponent(component);
        return this.___beginNode(vComponent, 0, true);
    },

    ___preserveComponent: function(component) {
        var vComponent = new VComponent(component, true);
        this.___beginNode(vComponent, 0);
    },

    ___beginNode: function(child, childCount, pushToStack) {
        this.___parent.___appendChild(child);
        if (pushToStack === true) {
            this.___stack.push(child);
            this.___parent = child;
        }
        return childCount === 0 ? this : child;
    },

    element: function(tagName, attrs, key, component, childCount, flags, props) {
        var element = new VElement(tagName, attrs, key, component, childCount, flags, props);
        return this.___beginNode(element, childCount);
    },

    ___elementDynamicTag: function(tagName, attrs, key, component, childCount, flags, props) {
        var element = VElement.___createElementDynamicTag(tagName, attrs, key, component, childCount, flags, props);
        return this.___beginNode(element, childCount);
    },

    n: function(node, component) {
        // NOTE: We do a shallow clone since we assume the node is being reused
        //       and a node can only have one parent node.
        var clone = node.___cloneNode();
        this.node(clone);
        clone.___component = component;

        return this;
    },

    node: function(node) {
        this.___parent.___appendChild(node);
        return this;
    },

    text: function(text) {
        var type = typeof text;

        if (type != 'string') {
            if (text == null) {
                return;
            } else if (type === 'object') {
                if (text.toHTML) {
                    return this.h(text.toHTML());
                }
            }

            text = text.toString();
        }

        this.___parent.___appendChild(new VText(text));
        return this;
    },

    comment: function(comment) {
        return this.node(new VComment(comment));
    },

    html: function(html) {
        if (html != null) {
            var vdomNode = virtualizeHTML(html, this.___document || document);
            this.node(vdomNode);
        }

        return this;
    },

    beginElement: function(tagName, attrs, key, component, childCount, flags, props) {
        var element = new VElement(tagName, attrs, key, component, childCount, flags, props);
        this.___beginNode(element, childCount, true);
        return this;
    },

    ___beginElementDynamicTag: function(tagName, attrs, key, component, childCount, flags, props) {
        var element = VElement.___createElementDynamicTag(tagName, attrs, key, component, childCount, flags, props);
        this.___beginNode(element, childCount, true);
        return this;
    },

    endElement: function() {
        var stack = this.___stack;
        stack.pop();
        this.___parent = stack[stack.length-1];
    },

    end: function() {
        this.___parent = undefined;

        var remaining = --this.___remaining;
        var parentOut = this.___parentOut;

        if (remaining === 0) {
            if (parentOut) {
                parentOut.___handleChildDone();
            } else {
                this.___doFinish();
            }
        } else if (remaining - this.___lastCount === 0) {
            this.___emitLast();
        }

        return this;
    },

    ___handleChildDone: function() {
        var remaining = --this.___remaining;

        if (remaining === 0) {
            var parentOut = this.___parentOut;
            if (parentOut) {
                parentOut.___handleChildDone();
            } else {
                this.___doFinish();
            }
        } else if (remaining - this.___lastCount === 0) {
            this.___emitLast();
        }
    },

    ___doFinish: function() {
        var state = this.___state;
        state.___finished = true;
        state.___events.emit(EVENT_FINISH, this.___getResult());
    },

    ___emitLast: function() {
        var lastArray = this._last;

        var i = 0;

        function next() {
            if (i === lastArray.length) {
                return;
            }
            var lastCallback = lastArray[i++];
            lastCallback(next);

            if (!lastCallback.length) {
                next();
            }
        }

        next();
    },

    error: function(e) {
        try {
            this.emit('error', e);
        } finally {
            // If there is no listener for the error event then it will
            // throw a new Error here. In order to ensure that the async fragment
            // is still properly ended we need to put the end() in a `finally`
            // block
            this.end();
        }

        return this;
    },

    beginAsync: function(options) {
        if (this.___sync) {
            throw Error('Not allowed');
        }

        var state = this.___state;

        if (options) {
            if (options.last) {
                this.___lastCount++;
            }
        }

        this.___remaining++;

        var documentFragment = this.___parent.___appendDocumentFragment();
        var asyncOut = new AsyncVDOMBuilder(this.global, documentFragment, this);

        state.___events.emit('beginAsync', {
           out: asyncOut,
           parentOut: this
       });

       return asyncOut;
    },

    createOut: function() {
        return new AsyncVDOMBuilder(this.global);
    },

    flush: function() {
        var events = this.___state.___events;

        if (events.listenerCount(EVENT_UPDATE)) {
            events.emit(EVENT_UPDATE, new RenderResult(this));
        }
    },

    ___getOutput: function() {
        return this.___state.___tree;
    },

    ___getResult: function() {
        return this.___result || (this.___result = new RenderResult(this));
    },

    on: function(event, callback) {
        var state = this.___state;

        if (event === EVENT_FINISH && state.___finished) {
            callback(this.___getResult());
        } else if (event === 'last') {
            this.onLast(callback);
        } else {
            state.___events.on(event, callback);
        }

        return this;
    },

    once: function(event, callback) {
        var state = this.___state;

        if (event === EVENT_FINISH && (state.___finished)) {
            callback(this.___getResult());
        } else if (event === 'last') {
            this.onLast(callback);
        } else {
            state.___events.once(event, callback);
        }

        return this;
    },

    emit: function(type, arg) {
        var events = this.___state.___events;
        switch(arguments.length) {
            case 1:
                events.emit(type);
                break;
            case 2:
                events.emit(type, arg);
                break;
            default:
                events.emit.apply(events, arguments);
                break;
        }
        return this;
    },

    removeListener: function() {
        var events = this.___state.___events;
        events.removeListener.apply(events, arguments);
        return this;
    },

    sync: function() {
        this.___sync = true;
    },

    isSync: function() {
        return this.___sync;
    },

    onLast: function(callback) {
        var lastArray = this._last;

        if (lastArray === undefined) {
            this._last = [callback];
        } else {
            lastArray.push(callback);
        }

        return this;
    },

    ___getNode: function(doc) {
        var node = this.___vnode;
        if (!node) {
            var vdomTree = this.___getOutput();
            // Create the root document fragment node
            doc = doc || this.___document || document;
            this.___vnode = node = vdomTree.___actualize(doc);
            morphdom(node, null, null, vdomTree, doc, this.___components);
        }
        return node;
    },

    toString: function(doc) {
        var docFragment = this.___getNode(doc);
        var html = '';

        var child = docFragment.firstChild;
        while(child) {
            var nextSibling = child.nextSibling;
            if (child.nodeType != 1) {
                var container = docFragment.ownerDocument.createElement('div');
                container.appendChild(child.cloneNode());
                html += container.innerHTML;
            } else {
                html += child.outerHTML;
            }

            child = nextSibling;
        }

        return html;
    },

    then: function(fn, fnErr) {
        var out = this;
        var promise = new Promise(function(resolve, reject) {
            out.on('error', reject)
                .on(EVENT_FINISH, function(result) {
                    resolve(result);
                });
        });

        return Promise.resolve(promise).then(fn, fnErr);
    },

    catch: function(fnErr) {
        return this.then(undefined, fnErr);
    },

    isVDOM: true,

    c: function(componentDef, key, customEvents) {
        this.___assignedComponentDef = componentDef;
        this.___assignedKey = key;
        this.___assignedCustomEvents = customEvents;
    }
};

proto.e = proto.element;
proto.ed = proto.___elementDynamicTag;
proto.be = proto.beginElement;
proto.bed = proto.___beginElementDynamicTag;
proto.ee = proto.endElement;
proto.t = proto.text;
proto.h = proto.w = proto.write = proto.html;

module.exports = AsyncVDOMBuilder;

});
$_mod.def("/marko$4.5.3/src/runtime/renderable", function(require, exports, module, __filename, __dirname) { var defaultCreateOut = require('/marko$4.5.3/src/runtime/createOut'/*'./createOut'*/);
var extend = require('/raptor-util$3.2.0/extend'/*'raptor-util/extend'*/);

function safeRender(renderFunc, finalData, finalOut, shouldEnd) {
    try {
        renderFunc(finalData, finalOut);

        if (shouldEnd) {
            finalOut.end();
        }
    } catch(err) {
        var actualEnd = finalOut.end;
        finalOut.end = function() {};

        setTimeout(function() {
            finalOut.end = actualEnd;
            finalOut.error(err);
        }, 0);
    }
    return finalOut;
}

module.exports = function(target, renderer) {
    var renderFunc = renderer && (renderer.renderer || renderer.render || renderer);
    var createOut = target.createOut || renderer.createOut || defaultCreateOut;

    return extend(target, {
        createOut: createOut,

        renderToString: function(data, callback) {
            var localData = data || {};
            var render = renderFunc || this._;
            var globalData = localData.$global;
            var out = createOut(globalData);

            out.global.template = this;

            if (globalData) {
                localData.$global = undefined;
            }

            if (callback) {
                out.on('finish', function() {
                       callback(null, out.toString(), out);
                   })
                   .once('error', callback);

                return safeRender(render, localData, out, true);
            } else {
                out.sync();
                render(localData, out);
                return out.toString();
            }
        },

        renderSync: function(data) {
            var localData = data || {};
            var render = renderFunc || this._;
            var globalData = localData.$global;
            var out = createOut(globalData);
            out.sync();

            out.global.template = this;

            if (globalData) {
                localData.$global = undefined;
            }

            render(localData, out);
            return out.___getResult();
        },

        /**
         * Renders a template to either a stream (if the last
         * argument is a Stream instance) or
         * provides the output to a callback function (if the last
         * argument is a Function).
         *
         * Supported signatures:
         *
         * render(data)
         * render(data, out)
         * render(data, stream)
         * render(data, callback)
         *
         * @param  {Object} data The view model data for the template
         * @param  {AsyncStream/AsyncVDOMBuilder} out A Stream, an AsyncStream/AsyncVDOMBuilder instance, or a callback function
         * @return {AsyncStream/AsyncVDOMBuilder} Returns the AsyncStream/AsyncVDOMBuilder instance that the template is rendered to
         */
        render: function(data, out) {
            var callback;
            var finalOut;
            var finalData;
            var globalData;
            var render = renderFunc || this._;
            var shouldBuffer = this.___shouldBuffer;
            var shouldEnd = true;

            if (data) {
                finalData = data;
                if ((globalData = data.$global)) {
                    finalData.$global = undefined;
                }
            } else {
                finalData = {};
            }

            if (out && out.___isOut) {
                finalOut = out;
                shouldEnd = false;
                extend(out.global, globalData);
            } else if (typeof out == 'function') {
                finalOut = createOut(globalData);
                callback = out;
            } else {
                finalOut = createOut(
                    globalData, // global
                    out, // writer(AsyncStream) or parentNode(AsyncVDOMBuilder)
                    undefined, // parentOut
                    shouldBuffer // ignored by AsyncVDOMBuilder
                );
            }

            if (callback) {
                finalOut
                    .on('finish', function() {
                        callback(null, finalOut.___getResult());
                    })
                    .once('error', callback);
            }

            globalData = finalOut.global;

            globalData.template = globalData.template || this;

            return safeRender(render, finalData, finalOut, shouldEnd);
        }
    });
};

});
$_mod.def("/marko$4.5.3/src/runtime/vdom/index", function(require, exports, module, __filename, __dirname) { 'use strict';
require('/marko$4.5.3/src/index-browser'/*'../../'*/);

// helpers provide a core set of various utility methods
// that are available in every template
var AsyncVDOMBuilder = require('/marko$4.5.3/src/runtime/vdom/AsyncVDOMBuilder'/*'./AsyncVDOMBuilder'*/);
var makeRenderable = require('/marko$4.5.3/src/runtime/renderable'/*'../renderable'*/);

/**
 * Method is for internal usage only. This method
 * is invoked by code in a compiled Marko template and
 * it is used to create a new Template instance.
 * @private
 */
exports.t = function createTemplate(path) {
     return new Template(path);
};

function Template(path, func) {
    this.path = path;
    this._ = func;
    this.meta = undefined;
}

function createOut(globalData, parent, parentOut) {
    return new AsyncVDOMBuilder(globalData, parent, parentOut);
}

var Template_prototype = Template.prototype = {
    createOut: createOut
};

makeRenderable(Template_prototype);

exports.Template = Template;
exports.___createOut = createOut;

require('/marko$4.5.3/src/runtime/createOut'/*'../createOut'*/).___setCreateOut(createOut);

});
$_mod.def("/marko$4.5.3/src/vdom", function(require, exports, module, __filename, __dirname) { module.exports = require('/marko$4.5.3/src/runtime/vdom/index'/*'./runtime/vdom'*/);

});
$_mod.remap("/marko$4.5.3/src/components/helpers", "/marko$4.5.3/src/components/helpers-browser");
$_mod.main("/marko$4.5.3/src/components", "");
$_mod.remap("/marko$4.5.3/src/components/index", "/marko$4.5.3/src/components/index-browser");
$_mod.def("/marko$4.5.3/src/components/index-browser", function(require, exports, module, __filename, __dirname) { var componentsUtil = require('/marko$4.5.3/src/components/util-browser'/*'./util'*/);
var initComponents = require('/marko$4.5.3/src/components/init-components-browser'/*'./init-components'*/);

require('/marko$4.5.3/src/components/ComponentsContext'/*'./ComponentsContext'*/).___initClientRendered = initComponents.___initClientRendered;

exports.getComponentForEl = componentsUtil.___getComponentForEl;
exports.init = initComponents.___initServerRendered;

});
$_mod.remap("/marko$4.5.3/src/components/beginComponent", "/marko$4.5.3/src/components/beginComponent-browser");
$_mod.def("/marko$4.5.3/src/components/beginComponent-browser", function(require, exports, module, __filename, __dirname) { var ComponentDef = require('/marko$4.5.3/src/components/ComponentDef'/*'./ComponentDef'*/);

module.exports = function beginComponent(componentsContext, component, isSplitComponen, parentComponentDeft) {
    var componentId = component.id;

    var globalContext = componentsContext.___globalContext;
    var componentDef = componentsContext.___componentDef = new ComponentDef(component, componentId, globalContext);
    globalContext.___renderedComponentsById[componentId] = true;
    componentsContext.___components.push(componentDef);

    var out = componentsContext.___out;
    out.bc(component);
    return componentDef;
};

});
$_mod.remap("/marko$4.5.3/src/components/endComponent", "/marko$4.5.3/src/components/endComponent-browser");
$_mod.def("/marko$4.5.3/src/components/endComponent-browser", function(require, exports, module, __filename, __dirname) { 'use strict';

module.exports = function endComponent(out) {
    out.ee(); // endElement() (also works for VComponent nodes pushed on to the stack)
};

});
$_mod.def("/marko$4.5.3/src/components/renderer", function(require, exports, module, __filename, __dirname) { var componentsUtil = require('/marko$4.5.3/src/components/util-browser'/*'./util'*/);
var componentLookup = componentsUtil.___componentLookup;
var emitLifecycleEvent = componentsUtil.___emitLifecycleEvent;

var ComponentsContext = require('/marko$4.5.3/src/components/ComponentsContext'/*'./ComponentsContext'*/);
var getComponentsContext = ComponentsContext.___getComponentsContext;
var registry = require('/marko$4.5.3/src/components/registry-browser'/*'./registry'*/);
var copyProps = require('/raptor-util$3.2.0/copyProps'/*'raptor-util/copyProps'*/);
var isServer = componentsUtil.___isServer === true;
var beginComponent = require('/marko$4.5.3/src/components/beginComponent-browser'/*'./beginComponent'*/);
var endComponent = require('/marko$4.5.3/src/components/endComponent-browser'/*'./endComponent'*/);

var COMPONENT_BEGIN_ASYNC_ADDED_KEY = '$wa';

function resolveComponentKey(globalComponentsContext, key, parentComponentDef) {
    if (key[0] === '#') {
        return key.substring(1);
    } else {
        return parentComponentDef.id + '-' + parentComponentDef.___nextKey(key);
    }
}

function handleBeginAsync(event) {
    var parentOut = event.parentOut;
    var asyncOut = event.out;
    var componentsContext = parentOut.___components;

    if (componentsContext !== undefined) {
        // We are going to start a nested ComponentsContext
        asyncOut.___components = new ComponentsContext(asyncOut, componentsContext);
    }
    // Carry along the component arguments
    asyncOut.c(
        parentOut.___assignedComponentDef,
        parentOut.___assignedKey,
        parentOut.___assignedCustomEvents);
}

function createRendererFunc(templateRenderFunc, componentProps, renderingLogic) {
    renderingLogic = renderingLogic || {};
    var onInput = renderingLogic.onInput;
    var typeName = componentProps.___type;
    var isSplit = componentProps.___split === true;
    var isImplicitComponent = componentProps.___implicit === true;

    var shouldApplySplitMixins = isSplit;

    return function renderer(input, out) {
        var outGlobal = out.global;

        if (out.isSync() === false) {
            if (!outGlobal[COMPONENT_BEGIN_ASYNC_ADDED_KEY]) {
                outGlobal[COMPONENT_BEGIN_ASYNC_ADDED_KEY] = true;
                out.on('beginAsync', handleBeginAsync);
            }
        }

        var componentsContext = getComponentsContext(out);
        var globalComponentsContext = componentsContext.___globalContext;

        var component = globalComponentsContext.___rerenderComponent;
        var isRerender = component !== undefined;
        var id;
        var isExisting;
        var customEvents;
        var scope;
        var parentComponentDef;

        if (component) {
            // If component is provided then we are currently rendering
            // the top-level UI component as part of a re-render
            id = component.id; // We will use the ID of the component being re-rendered
            isExisting = true; // This is a re-render so we know the component is already in the DOM
            globalComponentsContext.___rerenderComponent = null;
        } else {
            // Otherwise, we are rendering a nested UI component. We will need
            // to match up the UI component with the component already in the
            // DOM (if any) so we will need to resolve the component ID from
            // the assigned key. We also need to handle any custom event bindings
            // that were provided.
            parentComponentDef = componentsContext.___componentDef;
            var componentDefFromArgs;
            if ((componentDefFromArgs = out.___assignedComponentDef)) {
                // console.log('componentArgs:', componentArgs);
                scope = componentDefFromArgs.id;
                out.___assignedComponentDef = null;

                customEvents = out.___assignedCustomEvents;
                var key = out.___assignedKey;

                if (key != null) {
                    id = resolveComponentKey(globalComponentsContext, key.toString(), componentDefFromArgs);
                } else {
                    id = componentDefFromArgs.___nextComponentId();
                }
            } else {
                id = globalComponentsContext.___nextComponentId();
            }
        }

        if (isServer) {
            // If we are rendering on the server then things are simplier since
            // we don't need to match up the UI component with a previously
            // rendered component already mounted to the DOM. We also create
            // a lightweight ServerComponent
            component = registry.___createComponent(
                renderingLogic,
                id,
                input,
                out,
                typeName,
                customEvents,
                scope);

            // This is the final input after running the lifecycle methods.
            // We will be passing the input to the template for the `input` param
            input = component.___updatedInput;

            component.___updatedInput = undefined; // We don't want ___updatedInput to be serialized to the browser
        } else {
            if (!component) {
                if (isRerender && (component = componentLookup[id]) && component.___type !== typeName) {
                    // Destroy the existing component since
                    component.destroy();
                    component = undefined;
                }

                if (component) {
                    isExisting = true;
                } else {
                    isExisting = false;
                    // We need to create a new instance of the component
                    component = registry.___createComponent(typeName, id);

                    if (shouldApplySplitMixins === true) {
                        shouldApplySplitMixins = false;

                        var renderingLogicProps = typeof renderingLogic == 'function' ?
                            renderingLogic.prototype :
                            renderingLogic;

                        copyProps(renderingLogicProps, component.constructor.prototype);
                    }
                }

                // Set this flag to prevent the component from being queued for update
                // based on the new input. The component is about to be rerendered
                // so we don't want to queue it up as a result of calling `setInput()`
                component.___updateQueued = true;

                if (customEvents !== undefined) {
                    component.___setCustomEvents(customEvents, scope);
                }

                if (isExisting === false) {
                    emitLifecycleEvent(component, 'create', input, out);
                }

                input = component.___setInput(input, onInput, out);

                if (isExisting === true) {
                    if (component.___isDirty === false || component.shouldUpdate(input, component.___state) === false) {
                        // We put a placeholder element in the output stream to ensure that the existing
                        // DOM node is matched up correctly when using morphdom. We flag the VElement
                        // node to track that it is a preserve marker
                        out.___preserveComponent(component);
                        globalComponentsContext.___renderedComponentsById[id] = true;
                        component.___reset(); // The component is no longer dirty so reset internal flags
                        return;
                    }
                }
            }

            component.___global = outGlobal;

            emitLifecycleEvent(component, 'render', out);
        }

        var componentDef =
          beginComponent(componentsContext, component, isSplit, parentComponentDef, isImplicitComponent);

        componentDef.___isExisting = isExisting;

        // Render the template associated with the component using the final template
        // data that we constructed
        templateRenderFunc(input, out, componentDef, component, component.___rawState);

        endComponent(out, componentDef);
        componentsContext.___componentDef = parentComponentDef;
    };
}

module.exports = createRendererFunc;

// exports used by the legacy renderer
createRendererFunc.___resolveComponentKey = resolveComponentKey;
createRendererFunc.___handleBeginAsync = handleBeginAsync;

});
$_mod.def("/marko$4.5.3/src/components/helpers-browser", function(require, exports, module, __filename, __dirname) { require('/marko$4.5.3/src/components/index-browser'/*'./'*/);

exports.c = require('/marko$4.5.3/src/components/defineComponent'/*'./defineComponent'*/); // Referenced by compiled templates
exports.r = require('/marko$4.5.3/src/components/renderer'/*'./renderer'*/); // Referenced by compiled templates
exports.rc = require('/marko$4.5.3/src/components/registry-browser'/*'./registry'*/).___register;  // Referenced by compiled templates

});
$_mod.def("/marko$4.5.3/src/runtime/helpers", function(require, exports, module, __filename, __dirname) { 'use strict';
var isArray = Array.isArray;

function isFunction(arg) {
    return typeof arg == 'function';
}

function classList(arg, classNames) {
    var len;

    if (arg) {
        if (typeof arg == 'string') {
            if (arg) {
                classNames.push(arg);
            }
        } else if (typeof (len = arg.length) == 'number') {
            for (var i=0; i<len; i++) {
                classList(arg[i], classNames);
            }
        } else if (typeof arg == 'object') {
            for (var name in arg) {
                if (arg.hasOwnProperty(name)) {
                    var value = arg[name];
                    if (value) {
                        classNames.push(name);
                    }
                }
            }
        }
    }
}

function createDeferredRenderer(handler) {
    function deferredRenderer(input, out) {
        deferredRenderer.renderer(input, out);
    }

    // This is the initial function that will do the rendering. We replace
    // the renderer with the actual renderer func on the first render
    deferredRenderer.renderer = function(input, out) {
        var rendererFunc = handler.renderer || handler._ || handler.render;
        if (!isFunction(rendererFunc)) {
            throw Error('Invalid renderer');
        }
        // Use the actual renderer from now on
        deferredRenderer.renderer = rendererFunc;
        rendererFunc(input, out);
    };

    return deferredRenderer;
}

function resolveRenderer(handler) {
    var renderer = handler.renderer || handler._;

    if (renderer) {
        return renderer;
    }

    if (isFunction(handler)) {
        return handler;
    }

    // If the user code has a circular function then the renderer function
    // may not be available on the module. Since we can't get a reference
    // to the actual renderer(input, out) function right now we lazily
    // try to get access to it later.
    return createDeferredRenderer(handler);
}

var helpers = {
    /**
     * Internal helper method to prevent null/undefined from being written out
     * when writing text that resolves to null/undefined
     * @private
     */
    s: function strHelper(str) {
        return (str == null) ? '' : str.toString();
    },

    /**
     * Internal helper method to handle loops without a status variable
     * @private
     */
    f: function forEachHelper(array, callback) {
        if (isArray(array)) {
            for (var i=0; i<array.length; i++) {
                callback(array[i]);
            }
        } else if (isFunction(array)) {
            // Also allow the first argument to be a custom iterator function
            array(callback);
        }
    },

    /**
     * Helper to load a custom tag
     */
    t: function loadTagHelper(renderer, targetProperty, isRepeated) {
        if (renderer) {
            renderer = resolveRenderer(renderer);
        }

        return function wrappedRenderer(input, out, componentDef, key, customEvents) {
            out.c(componentDef, key, customEvents);
            renderer(input, out);
            out.___assignedComponentDef = null;
        };
    },

    /**
     * classList(a, b, c, ...)
     * Joines a list of class names with spaces. Empty class names are omitted.
     *
     * classList('a', undefined, 'b') --> 'a b'
     *
     */
    cl: function classListHelper() {
        var classNames = [];
        classList(arguments, classNames);
        return classNames.join(' ');
    }
};

module.exports = helpers;

});
$_mod.def("/marko$4.5.3/src/runtime/vdom/helpers", function(require, exports, module, __filename, __dirname) { 'use strict';

var vdom = require('/marko$4.5.3/src/runtime/vdom/vdom'/*'./vdom'*/);
var VElement = vdom.___VElement;
var VText = vdom.___VText;

var commonHelpers = require('/marko$4.5.3/src/runtime/helpers'/*'../helpers'*/);
var extend = require('/raptor-util$3.2.0/extend'/*'raptor-util/extend'*/);

var classList = commonHelpers.cl;

var helpers = extend({
    e: function(tagName, attrs, key, component, childCount, flags, props) {
        return new VElement(tagName, attrs, key, component, childCount, flags, props);
    },

    t: function(value) {
        return new VText(value);
    },

    const: function(id) {
        var i=0;
        return function() {
            return id + (i++);
        };
    },

    /**
     * Internal helper method to handle the "class" attribute. The value can either
     * be a string, an array or an object. For example:
     *
     * ca('foo bar') ==> ' class="foo bar"'
     * ca({foo: true, bar: false, baz: true}) ==> ' class="foo baz"'
     * ca(['foo', 'bar']) ==> ' class="foo bar"'
     */
    ca: function(classNames) {
        if (!classNames) {
            return null;
        }

        if (typeof classNames === 'string') {
            return classNames;
        } else {
            return classList(classNames);
        }
    }
}, commonHelpers);

module.exports = helpers;

});
$_mod.def("/marko-express-starter$0.0.0/views/components/cout/index.marko", function(require, exports, module, __filename, __dirname) { // Compiled using marko@4.5.3 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require('/marko$4.5.3/src/vdom'/*"marko/src/vdom"*/).t(),
    marko_component = {
        onCreate: function() {
          this.state = {
              count: 0
            };
        },
        onMount: function() {
          console.log("Mounted in the browser!");

          var a = name;

          console.log(a);
        },
        increment: function() {
          this.state.count++;
        }
      },
    components_helpers = require('/marko$4.5.3/src/components/helpers-browser'/*"marko/src/components/helpers"*/),
    marko_registerComponent = components_helpers.rc,
    marko_componentType = marko_registerComponent("/marko-express-starter$0.0.0/views/components/cout/index.marko", function() {
      return module.exports;
    }),
    marko_renderer = components_helpers.r,
    marko_defineComponent = components_helpers.c,
    marko_helpers = require('/marko$4.5.3/src/runtime/vdom/helpers'/*"marko/src/runtime/vdom/helpers"*/),
    marko_createElement = marko_helpers.e,
    marko_const = marko_helpers.const,
    marko_const_nextId = marko_const("972337"),
    marko_node0 = marko_createElement("P", null, "1", null, 1, 0, {
        i: marko_const_nextId()
      })
      .t("All of this is imported from the componets"),
    marko_attrs0 = {
        "class": "count"
      },
    marko_attrs1 = {
        type: "button"
      };

function render(input, out, __component, component, state) {
  var data = input;

  out.e("P", null, "0", component, 2)
    .t("Hello ")
    .t(input.name);

  out.n(marko_node0, component);

  out.e("DIV", marko_attrs0, "2", component, 1)
    .t(state.count);

  out.e("BUTTON", marko_attrs1, "3", component, 1, 0, {
      onclick: __component.d("increment")
    })
    .t("Click me");
}

marko_template._ = marko_renderer(render, {
    ___type: marko_componentType
  }, marko_component);

marko_template.Component = marko_defineComponent(marko_component, marko_template._);

});