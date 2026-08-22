package com.goodmarket.app

import android.webkit.WebView
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Singleton router bridging the two WebViews of the dApp browser:
 *
 *   hostWebView   — the Capacitor WebView on the GoodMarket origin, where
 *                   dapp-browser-host.js (GMDappHost) and the local wallet
 *                   (GMLocalWallet) live. ALL signing happens here; key
 *                   material never leaves this context.
 *   activeBrowser — the dApp screen (DappBrowserActivity) on an arbitrary
 *                   origin, running the injected dapp-browser-bridge.js.
 *
 * Flow: dApp page -> GmAndroidBridge.request -> forwardToHost ->
 * GMDappHost.nativeHandle -> host JS interface -> deliverReply ->
 * __gmBridgeResolve inside the dApp WebView.
 */
object GmBridgeRouter {

    data class PendingRequest(val method: String, val paramsJson: String)

    @Volatile var hostWebView: WebView? = null
    @Volatile var activeBrowser: DappBrowserActivity? = null

    /** Requests awaiting resolution, keyed by bridge id (for PIN retries). */
    val pending = ConcurrentHashMap<Int, PendingRequest>()

    fun forwardToHost(id: Int, requestJson: String) {
        val host = hostWebView ?: return
        val obj = try { JSONObject(requestJson) } catch (e: Exception) { return }
        val method = obj.optString("method")
        val paramsJson = obj.optJSONArray("params")?.toString() ?: "[]"
        pending[id] = PendingRequest(method, paramsJson)
        host.post {
            host.evaluateJavascript(
                "window.GMDappHost && GMDappHost.nativeHandle(" +
                    "$id, ${JSONObject.quote(method)}, ${JSONObject.quote(paramsJson)});",
                null
            )
        }
    }

    fun deliverReply(id: Int, ok: Boolean, payloadJson: String) {
        activeBrowser?.resolve(id, ok, payloadJson)
    }

    fun deliverEvent(name: String, payloadJson: String) {
        activeBrowser?.pushEvent(name, payloadJson)
    }

    /** After a native PIN prompt, unlock on the host then retry the request. */
    fun unlockAndRetry(id: Int, pin: String) {
        val host = hostWebView ?: return
        val req = pending[id] ?: return
        host.post {
            host.evaluateJavascript(
                "window.GMDappHost && GMDappHost.nativeUnlockAndRetry(" +
                    "$id, ${JSONObject.quote(req.method)}, " +
                    "${JSONObject.quote(req.paramsJson)}, ${JSONObject.quote(pin)});",
                null
            )
        }
    }
}
