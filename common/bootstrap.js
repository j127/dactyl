// Copyright (c) 2010-2011 by Kris Maglione <maglione.k@gmail.com>
//
// This work is licensed for reuse under an MIT license. Details are
// given in the LICENSE.txt file included with this file.
//
// See https://wiki.mozilla.org/Extension_Manager:Bootstrapped_Extensions
// for details.

const NAME = "bootstrap";
const global = this;

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;

function module(uri) {
    let obj = {};
    Cu.import(uri, obj);
    return obj;
}

const { AddonManager } = module("resource://gre/modules/AddonManager.jsm");
const { XPCOMUtils }   = module("resource://gre/modules/XPCOMUtils.jsm");
const { Services }     = module("resource://gre/modules/Services.jsm");

const resourceProto = Services.io.getProtocolHandler("resource")
                              .QueryInterface(Ci.nsIResProtocolHandler);
const categoryManager = Cc["@mozilla.org/categorymanager;1"].getService(Ci.nsICategoryManager);
const manager = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);

const BOOTSTRAP_JSM = "resource://dactyl/bootstrap.jsm";

const BOOTSTRAP_CONTRACT = "@dactyl.googlecode.com/base/bootstrap";
JSMLoader = JSMLoader || BOOTSTRAP_CONTRACT in Cc && Cc[BOOTSTRAP_CONTRACT].getService().wrappedJSObject.loader;

var JSMLoader = BOOTSTRAP_CONTRACT in Components.classes &&
    Components.classes[BOOTSTRAP_CONTRACT].getService().wrappedJSObject.loader;

// Temporary migration code.
if (!JSMLoader && "@mozilla.org/fuel/application;1" in Components.classes)
    JSMLoader = Components.classes["@mozilla.org/fuel/application;1"]
                          .getService(Components.interfaces.extIApplication)
                          .storage.get("dactyl.JSMLoader", null);

function reportError(e) {
    dump("\ndactyl: bootstrap: " + e + "\n" + (e.stack || Error().stack) + "\n");
    Cu.reportError(e);
}

function httpGet(url) {
    let xmlhttp = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance(Ci.nsIXMLHttpRequest);
    xmlhttp.overrideMimeType("text/plain");
    xmlhttp.open("GET", url, false);
    xmlhttp.send(null);
    return xmlhttp;
}

let initialized = false;
let addon = null;
let addonData = null;
let basePath = null;
let categories = [];
let components = {};
let resources = [];
let getURI = null;

/**
 * Performs necessary migrations after a version change.
 */
function updateVersion() {
    try {
        function isDev(ver) /^hg|pre$/.test(ver);
        if (typeof require === "undefined" || addon === addonData)
            return;

        require(global, "config");
        require(global, "prefs");
        config.lastVersion = localPrefs.get("lastVersion", null);

        localPrefs.set("lastVersion", addon.version);

        // We're switching from a nightly version to a stable or
        // semi-stable version or vice versa.
        //
        // Disable automatic updates when switching to nightlies,
        // restore the default action when switching to stable.
        if (!config.lastVersion || isDev(config.lastVersion) != isDev(addon.version))
            addon.applyBackgroundUpdates = AddonManager[isDev(addon.version) ? "AUTOUPDATE_DISABLE" : "AUTOUPDATE_DEFAULT"];
    }
    catch (e) {
        reportError(e);
    }
}

function startup(data, reason) {
    dump("dactyl: bootstrap: startup " + reasonToString(reason) + "\n");
    basePath = data.installPath;

    if (!initialized) {
        initialized = true;

        dump("dactyl: bootstrap: init" + " " + data.id + "\n");

        addonData = data;
        addon = data;
        AddonManager.getAddonByID(addon.id, function (a) {
            addon = a;
            updateVersion();
            if (typeof require !== "undefined")
                require(global, "overlay");
        });

        if (basePath.isDirectory())
            getURI = function getURI(path) {
                let uri = Services.io.newFileURI(basePath);
                uri.path += path;
                return Services.io.newFileURI(uri.QueryInterface(Ci.nsIFileURL).file);
            };
        else
            getURI = function getURI(path)
                Services.io.newURI("jar:" + Services.io.newFileURI(basePath).spec + "!/" + path, null, null);

        try {
            init();
        }
        catch (e) {
            reportError(e);
        }
    }
}

/**
 * An XPCOM class factory proxy. Loads the JavaScript module at *url*
 * when an instance is to be created and calls its NSGetFactory method
 * to obtain the actual factory.
 *
 * @param {string} url The URL of the module housing the real factory.
 * @param {string} classID The CID of the class this factory represents.
 */
function FactoryProxy(url, classID) {
    this.url = url;
    this.classID = Components.ID(classID);
}
FactoryProxy.prototype = {
    QueryInterface: XPCOMUtils.generateQI(Ci.nsIFactory),
    register: function () {
        dump("dactyl: bootstrap: register: " + this.classID + " " + this.contractID + "\n");

        JSMLoader.registerFactory(this);
    },
    get module() {
        dump("dactyl: bootstrap: create module: " + this.contractID + "\n");

        Object.defineProperty(this, "module", { value: {}, enumerable: true });
        JSMLoader.load(this.url, this.module);
        return this.module;
    },
    createInstance: function (iids) {
        return let (factory = this.module.NSGetFactory(this.classID))
            factory.createInstance.apply(factory, arguments);
    }
}

function init() {
    dump("dactyl: bootstrap: init\n");

    let manifestURI = getURI("chrome.manifest");
    let manifest = httpGet(manifestURI.spec)
            .responseText
            .replace(/^\s*|\s*$|#.*/g, "")
            .replace(/^\s*\n/gm, "");

    let suffix = "-";
    let chars = "0123456789abcdefghijklmnopqrstuv";
    for (let n = Date.now(); n; n = Math.round(n / chars.length))
        suffix += chars[n % chars.length];

    for each (let line in manifest.split("\n")) {
        let fields = line.split(/\s+/);
        switch(fields[0]) {
        case "category":
            categoryManager.addCategoryEntry(fields[1], fields[2], fields[3], false, true);
            categories.push([fields[1], fields[2]]);
            break;
        case "component":
            components[fields[1]] = new FactoryProxy(getURI(fields[2]).spec, fields[1]);
            break;
        case "contract":
            components[fields[2]].contractID = fields[1];
            break;

        case "resource":
            var hardSuffix = /^[^\/]*/.exec(fields[2])[0];

            resources.push(fields[1], fields[1] + suffix);
            resourceProto.setSubstitution(fields[1], getURI(fields[2]));
            resourceProto.setSubstitution(fields[1] + suffix, getURI(fields[2]));
        }
    }

    // Flush the cache if necessary, just to be paranoid
    let pref = "extensions.dactyl.cacheFlushCheck";
    let val  = addon.version + "-" + hardSuffix;
    if (!Services.prefs.prefHasUserValue(pref) || Services.prefs.getCharPref(pref) != val) {
        Services.obs.notifyObservers(null, "startupcache-invalidate", "");
        Services.prefs.setCharPref(pref, val);
    }

    try {
        module("resource://dactyl-content/disable-acr.jsm").init(addon.id);
    }
    catch (e) {
        reportError(e);
    }

    if (JSMLoader) {
        // Temporary hacks until platforms and dactyl releases that don't
        // support Cu.unload are phased out.
        if (Cu.unload) {
            // Upgrading from dactyl release without Cu.unload support.
            Cu.unload(BOOTSTRAP_JSM);
            for (let [name] in Iterator(JSMLoader.globals))
                Cu.unload(~name.indexOf(":") ? name : "resource://dactyl" + JSMLoader.suffix + "/" + name);
        }
        else if (JSMLoader.bump != 6) {
            // We're in a version without Cu.unload support and the
            // JSMLoader interface has changed. Bump off the old one.
            Services.scriptloader.loadSubScript("resource://dactyl" + suffix + "/bootstrap.jsm",
                Cu.import(BOOTSTRAP_JSM, global));
        }
    }

    if (!JSMLoader || JSMLoader.bump !== 6 || Cu.unload)
        Cu.import(BOOTSTRAP_JSM, global);

    JSMLoader.bootstrap = this;

    JSMLoader.load(BOOTSTRAP_JSM, global);

    JSMLoader.init(suffix);
    JSMLoader.load("base.jsm", global);

    if (!(BOOTSTRAP_CONTRACT in Cc))
        manager.registerFactory(Components.ID("{f541c8b0-fe26-4621-a30b-e77d21721fb5}"),
                                String("{f541c8b0-fe26-4621-a30b-e77d21721fb5}"),
                                BOOTSTRAP_CONTRACT, {
            QueryInterface: XPCOMUtils.generateQI([Ci.nsIFactory]),
            instance: {
                QueryInterface: XPCOMUtils.generateQI([]),
                contractID: BOOTSTRAP_CONTRACT,
                wrappedJSObject: {}
            },
            // Use Sandbox to prevent closure over this scope
            createInstance: Cu.evalInSandbox("(function () this.instance)",
                                             Cu.Sandbox(Cc["@mozilla.org/systemprincipal;1"].getService()))
        });

    Cc[BOOTSTRAP_CONTRACT].getService().wrappedJSObject.loader = !Cu.unload && JSMLoader;

    for each (let component in components)
        component.register();

    Services.obs.notifyObservers(null, "dactyl-rehash", null);
    updateVersion();

    if (addon !== addonData)
        require(global, "overlay");
}

function shutdown(data, reason) {
    dump("dactyl: bootstrap: shutdown " + reasonToString(reason) + "\n");
    if (reason != APP_SHUTDOWN) {
        try {
            module("resource://dactyl-content/disable-acr.jsm").cleanup();
        }
        catch (e) {
            reportError(e);
        }

        if (~[ADDON_UPGRADE, ADDON_DOWNGRADE, ADDON_UNINSTALL].indexOf(reason))
            Services.obs.notifyObservers(null, "dactyl-purge", null);

        Services.obs.notifyObservers(null, "dactyl-cleanup", reasonToString(reason));
        Services.obs.notifyObservers(null, "dactyl-cleanup-modules", reasonToString(reason));

        JSMLoader.purge();
        for each (let [category, entry] in categories)
            categoryManager.deleteCategoryEntry(category, entry, false);
        for each (let resource in resources)
            resourceProto.setSubstitution(resource, null);
    }
}

function reasonToString(reason) {
    for each (let name in ["disable", "downgrade", "enable",
                           "install", "shutdown", "startup",
                           "uninstall", "upgrade"])
        if (reason == global["ADDON_" + name.toUpperCase()] ||
            reason == global["APP_" + name.toUpperCase()])
            return name;
}

function install(data, reason) { dump("dactyl: bootstrap: install " + reasonToString(reason) + "\n"); }
function uninstall(data, reason) { dump("dactyl: bootstrap: uninstall " + reasonToString(reason) + "\n"); }

// vim: set fdm=marker sw=4 ts=4 et:
