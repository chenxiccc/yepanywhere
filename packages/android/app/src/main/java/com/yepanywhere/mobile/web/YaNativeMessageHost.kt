package com.yepanywhere.mobile.web

import android.net.Uri
import android.webkit.WebView
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.yepanywhere.mobile.BuildConfig
import java.util.concurrent.atomic.AtomicBoolean

class YaNativeMessageHost private constructor(
    private val webView: WebView,
    private val allowedOrigin: String,
    private val protocol: NativeHostProtocol,
    private val operations: NativeHostOperations,
) {
    private var documentVersion = 0L
    private var destroyed = false

    fun onDocumentChanged() {
        documentVersion += 1
        protocol.onDocumentChanged()
    }

    fun destroy() {
        destroyed = true
        documentVersion += 1
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
        if (
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !isMainFrame ||
            normalizedOrigin(sourceOrigin) != allowedOrigin
        ) {
            return
        }
        if (message.type != WebMessageCompat.TYPE_STRING) {
            postDispatch(protocol.handle(null), reply)
            return
        }
        postDispatch(protocol.handle(message.data), reply)
    }

    private fun postDispatch(
        dispatch: NativeHostDispatch,
        reply: androidx.webkit.JavaScriptReplyProxy,
    ) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            return
        }
        when (dispatch) {
            is NativeHostDispatch.Reply -> reply.postMessage(dispatch.message)
            is NativeHostDispatch.Invoke -> invoke(dispatch.invocation, reply)
        }
    }

    private fun invoke(
        invocation: NativeHostInvocation,
        reply: androidx.webkit.JavaScriptReplyProxy,
    ) {
        val requestDocumentVersion = documentVersion
        val completed = AtomicBoolean(false)
        operations.invoke(invocation.method, invocation.params) completion@ { result ->
            if (!completed.compareAndSet(false, true)) {
                return@completion
            }
            webView.post {
                if (
                    !destroyed &&
                    requestDocumentVersion == documentVersion &&
                    WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                ) {
                    reply.postMessage(protocol.complete(invocation.id, result))
                }
            }
        }
    }

    companion object {
        const val OBJECT_NAME = "yaNative"

        fun install(
            webView: WebView,
            config: WebClientConfig,
            operations: NativeHostOperations,
        ): YaNativeMessageHost? {
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
                        features = operations.features,
                    ),
                ),
                operations = operations,
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
