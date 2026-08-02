package com.yepanywhere.mobile.web

enum class NavigationDecision {
    ALLOW_IN_APP,
    OPEN_EXTERNALLY,
    BLOCK,
}

object WebClientNavigation {
    fun decide(url: String, appOrigin: String): NavigationDecision {
        val origin = runCatching { WebClientOrigin.parse(url) }.getOrNull()
            ?: return NavigationDecision.BLOCK
        if (origin == appOrigin) {
            return NavigationDecision.ALLOW_IN_APP
        }

        return if (origin.startsWith("https://")) {
            NavigationDecision.OPEN_EXTERNALLY
        } else {
            NavigationDecision.BLOCK
        }
    }
}
