package com.goodmarket.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.getcapacitor.BridgeActivity
import com.getcapacitor.WebViewListener

/**
 * Capacitor entry activity. Its WebView serves the GoodMarket web app
 * (server.url in capacitor.config.json) — wallet.html loads
 * dapp-browser-host.js there, which owns all signing via GMLocalWallet.
 *
 * This class registers the DappBrowser plugin (wallet page "DApp Browser"
 * button), installs the reply/event hooks the host JS calls
 * (window.__gmHostReply / __gmHostEvent), and sets window.__gmNativeUnlock
 * so the host delegates PIN prompts to the native shell.
 */
class MainActivity : BridgeActivity() {

    @SuppressLint("AddJavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        // Plugin registration must happen before super.onCreate so the
        // bridge exposes it to web code as Capacitor.Plugins.DappBrowser.
        registerPlugin(DappBrowserPlugin::class.java)
        super.onCreate(savedInstanceState)
        GmBridgeRouter.hostWebView = bridge.webView
        bridge.webView.addJavascriptInterface(HostJsInterface(), "GmHostBridge")
        installHostHooks()
        // A fresh page load wipes window.__gm* — reinstall on every finished
        // navigation, not just onCreate/onResume.
        bridge.addWebViewListener(object : WebViewListener() {
            override fun onPageFinished(webView: WebView) {
                installHostHooks()
            }
        })
    }

    /** Hooks the host page calls back into after resolving requests. */
    private fun installHostHooks() {
        bridge.webView.evaluateJavascript(
            "window.__gmNativeUnlock = true;\n" +
            "window.__gmHostReply = function (id, ok, json) {\n" +
            "    GmHostBridge.post(id, ok, json);\n" +
            "};\n" +
            "window.__gmHostEvent = function (name, json) {\n" +
            "    GmHostBridge.event(name, json);\n" +
            "};",
            null
        )
    }

    /** JS interface the host page calls back into. */
    private class HostJsInterface {
        @JavascriptInterface
        fun post(id: Int, ok: Boolean, json: String) =
            GmBridgeRouter.deliverReply(id, ok, json)

        @JavascriptInterface
        fun event(name: String, json: String) =
            GmBridgeRouter.deliverEvent(name, json)
    }
}
