package com.goodmarket.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.JavascriptInterface
import com.getcapacitor.BridgeActivity

/**
 * Capacitor entry activity. Its WebView serves the GoodMarket web app
 * (server.url in capacitor.config.json) — wallet.html loads
 * dapp-browser-host.js there, which owns all signing via GMLocalWallet.
 *
 * This class installs the reply/event hooks that the host JS calls
 * (window.__gmHostReply / __gmHostEvent) plus the window.__gmNativeUnlock
 * marker telling the host to delegate PIN prompts to the native shell.
 */
class MainActivity : BridgeActivity() {

    @SuppressLint("AddJavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        GmBridgeRouter.hostWebView = bridge.webView
        bridge.webView.addJavascriptInterface(HostJsInterface(), "GmHostBridge")
    }

    override fun onResume() {
        super.onResume()
        installHostHooks()
    }

    /**
     * Re-installed on every resume. TODO(production): hook the Capacitor
     * WebViewListener's page-finished callback so full page navigations
     * inside the main WebView never leave these hooks uninstalled.
     */
    private fun installHostHooks() {
        bridge.webView.evaluateJavascript(
            """
            window.__gmNativeUnlock = true;
            window.__gmHostReply = function (id, ok, json) {
                GmHostBridge.post(id, ok, json);
            };
            window.__gmHostEvent = function (name, json) {
                GmHostBridge.event(name, json);
            };
            """.trimIndent(),
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
