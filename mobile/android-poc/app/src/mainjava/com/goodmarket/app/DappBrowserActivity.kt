package com.goodmarket.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.text.InputType
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import org.json.JSONObject

/**
 * Standalone dApp browser screen. Loads any https:// URL (e.g.
 * https://claim.superfluid.org) and injects dapp-browser-bridge.js so the
 * page sees a standard window.ethereum backed by the GoodMarket wallet.
 *
 * The bridge script is a packaged copy of static/js/dapp-browser-bridge.js
 * (kept in mobile/www/js — keep both in sync).
 */
class DappBrowserActivity : Activity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        setContentView(webView)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
        }
        // Transport #1 in dapp-browser-bridge.js (window.__gmBridgeNative).
        webView.addJavascriptInterface(object {
            @JavascriptInterface
            fun request(id: Int, json: String) =
                GmBridgeRouter.forwardToHost(id, json)
        }, "GmAndroidBridge")
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                injectBridge(view)
            }
        }
        GmBridgeRouter.activeBrowser = this
        webView.loadUrl(intent.getStringExtra(EXTRA_URL) ?: DEFAULT_URL)
    }

    override fun onDestroy() {
        if (GmBridgeRouter.activeBrowser === this) GmBridgeRouter.activeBrowser = null
        super.onDestroy()
    }

    /** Install the native transport shim, then the EIP-1193 payload. */
    private fun injectBridge(view: WebView) {
        val bridgeJs = runCatching {
            assets.open(BRIDGE_ASSET).bufferedReader().use { it.readText() }
        }.getOrNull() ?: return
        view.evaluateJavascript(
            "window.__gmBridgeNative = { request: function (id, json) { " +
                "GmAndroidBridge.request(id, json); } };",
            null
        )
        view.evaluateJavascript(bridgeJs, null)
    }

    /** Host resolved a request — ferry the outcome into the dApp page. */
    fun resolve(id: Int, ok: Boolean, payloadJson: String) {
        if (!ok && JSONObject(payloadJson).optJSONObject("error")
            ?.optString("code") == "GM_NEEDS_UNLOCK"
        ) {
            promptPin(id)
            return
        }
        GmBridgeRouter.pending.remove(id)
        runOnUiThread {
            webView.evaluateJavascript(
                "window.__gmBridgeResolve($id, $ok, ${JSONObject.quote(payloadJson)});",
                null
            )
        }
    }

    /**
     * Native PIN sheet. The host WebView's own DOM modal is behind this
     * screen, so the shell collects the PIN and the host unlocks in JS —
     * key material never enters native code.
     */
    private fun promptPin(id: Int) {
        runOnUiThread {
            val input = EditText(this).apply {
                inputType =
                    InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
                hint = "6-digit PIN"
            }
            AlertDialog.Builder(this)
                .setTitle("Sign with GoodMarket")
                .setMessage("Enter your GoodMarket PIN to confirm this action.")
                .setView(input)
                .setPositiveButton("Sign & Continue") { _, _ ->
                    GmBridgeRouter.unlockAndRetry(id, input.text.toString())
                }
                .setNegativeButton("Cancel") { _, _ ->
                    GmBridgeRouter.pending.remove(id)
                    webView.evaluateJavascript(
                        "window.__gmBridgeResolve($id, false, " +
                            JSONObject.quote(
                                "{\"error\":{\"message\":\"User rejected\",\"code\":4001}}"
                            ) + ");",
                        null
                    )
                }
                .show()
        }
    }

    /** Relay a wallet event (accountsChanged / chainChanged) into the page. */
    fun pushEvent(name: String, payloadJson: String) {
        runOnUiThread {
            webView.evaluateJavascript(
                "window.__gmBridgeEvent(${JSONObject.quote(name)}, " +
                    "${JSONObject.quote(payloadJson)});",
                null
            )
        }
    }

    companion object {
        const val EXTRA_URL = "url"
        const val BRIDGE_ASSET = "public/js/dapp-browser-bridge.js"
        const val DEFAULT_URL = "https://claim.superfluid.org"
    }
}
