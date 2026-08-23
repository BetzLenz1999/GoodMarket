package com.goodmarket.app

import android.content.Intent
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod

/**
 * Capacitor plugin that launches the dApp browser screen from the wallet
 * page. Registered in MainActivity; surfaced to web code as
 * window.Capacitor.Plugins.DappBrowser, method "open".
 *
 * The wallet page calls it with an optional { url } — defaults to
 * DappBrowserActivity.DEFAULT_URL when omitted.
 */
@CapacitorPlugin(name = "DappBrowser")
class DappBrowserPlugin : Plugin() {

    @PluginMethod
    fun open(call: PluginCall) {
        val url = call.getString("url") ?: DappBrowserActivity.DEFAULT_URL
        val intent = Intent(context, DappBrowserActivity::class.java)
            .putExtra(DappBrowserActivity.EXTRA_URL, url)
        activity.startActivity(intent)
        call.resolve()
    }
}
