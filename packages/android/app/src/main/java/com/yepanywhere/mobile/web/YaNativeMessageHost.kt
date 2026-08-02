package com.yepanywhere.mobile.web

import android.net.Uri
import android.webkit.WebView
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.yepanywhere.mobile.BuildConfig

class YaNativeMessageHost private constructor(
    private val webView: WebView,
    private val allowedOrigin: String,
    private val protocol: NativeHostProtocol,
) {
    fun onDocumentChanged() {
        protocol.onDocumentChanged()
    }

    fun destroy() {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.removeWebMessageListener(webView, OBJECT_NAME)
        }
    }

    private fun onMessage(
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        reply: androidx.webkit.JavaScriptReplyProxy,
    ) {
        if (!isMainFrame || normalizedOrigin(sourceOrigin) != allowedOrigin) {
            return
        }
        if (message.type != WebMessageCompat.TYPE_STRING) {
            reply.postMessage(protocol.handle(null))
            return
        }
        reply.postMessage(protocol.handle(message.data))
    }

    companion object {
        const val OBJECT_NAME = "yaNative"

        fun install(webView: WebView, config: WebClientConfig): YaNativeMessageHost? {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                return null
            }
            val host = YaNativeMessageHost(
                webView = webView,
                allowedOrigin = config.origin,
                protocol = NativeHostProtocol(
                    NativeHostDescriptor(
                        platform = "android",
                        appVersion = BuildConfig.VERSION_NAME,
                        buildVersion = BuildConfig.VERSION_CODE.toLong(),
                        features = emptyList(),
                    ),
                ),
            )
            WebViewCompat.addWebMessageListener(
                webView,
                OBJECT_NAME,
                setOf(config.origin),
            ) { _, message, sourceOrigin, isMainFrame, reply ->
                host.onMessage(message, sourceOrigin, isMainFrame, reply)
            }
            return host
        }

        private fun normalizedOrigin(origin: Uri): String? {
            return runCatching { WebClientOrigin.parse(origin.toString()) }.getOrNull()
        }
    }
}
