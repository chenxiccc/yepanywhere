package com.yepanywhere.mobile.web

import org.junit.Assert.assertEquals
import org.junit.Test

class WebClientNavigationTest {
    private val appOrigin = "https://appassets.androidplatform.net"

    @Test
    fun allowsOnlyTheExactConfiguredOriginInApp() {
        assertEquals(
            NavigationDecision.ALLOW_IN_APP,
            WebClientNavigation.decide(
                "https://appassets.androidplatform.net/projects/one",
                appOrigin,
            ),
        )
        assertEquals(
            NavigationDecision.OPEN_EXTERNALLY,
            WebClientNavigation.decide("https://example.com/", appOrigin),
        )
    }

    @Test
    fun blocksUnsafeAndMalformedSchemes() {
        for (url in listOf("javascript:alert(1)", "file:///tmp/a", "not a url")) {
            assertEquals(
                NavigationDecision.BLOCK,
                WebClientNavigation.decide(url, appOrigin),
            )
        }
    }

    @Test
    fun treatsNonDefaultPortsAsDifferentOrigins() {
        assertEquals(
            NavigationDecision.OPEN_EXTERNALLY,
            WebClientNavigation.decide(
                "https://appassets.androidplatform.net:444/",
                appOrigin,
            ),
        )
    }
}
