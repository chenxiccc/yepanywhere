package com.yepanywhere.mobile.web

import com.yepanywhere.mobile.BuildConfig
import java.net.URI
import java.util.Locale

data class WebClientConfig(
    val startUrl: String,
    val origin: String,
    val bundled: Boolean,
) {
    companion object {
        fun fromBuild(): WebClientConfig {
            val debugOverride = BuildConfig.DEBUG_WEB_CLIENT_URL
                .takeIf { BuildConfig.DEBUG && it.isNotBlank() }
            val startUrl = debugOverride ?: BuildConfig.WEB_CLIENT_URL
            return WebClientConfig(
                startUrl = startUrl,
                origin = WebClientOrigin.parse(startUrl),
                bundled = BuildConfig.BUNDLED_CLIENT && debugOverride == null,
            )
        }
    }
}

object WebClientOrigin {
    fun parse(url: String): String {
        val uri = URI(url)
        require(!uri.isOpaque && uri.userInfo == null && uri.host != null) {
            "Web client URL must be an absolute network URL without user info"
        }

        val scheme = uri.scheme.lowercase(Locale.ROOT)
        require(scheme == "http" || scheme == "https") {
            "Web client URL must use http or https"
        }

        val host = uri.host.lowercase(Locale.ROOT)
        val defaultPort = when (scheme) {
            "http" -> 80
            else -> 443
        }
        val port = uri.port.takeIf { it != -1 && it != defaultPort }
        val printableHost = if (host.contains(':')) "[$host]" else host
        return buildString {
            append(scheme)
            append("://")
            append(printableHost)
            if (port != null) {
                append(':')
                append(port)
            }
        }
    }
}
