package com.yepanywhere.mobile.links

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AppLinkDestinationTest {
    private val clientUrl = "https://appassets.androidplatform.net/"

    @Test
    fun mapsCredentialsToTheFixedClientOriginFragment() {
        assertEquals(
            "https://appassets.androidplatform.net/#u=user%2Bname&p=safe%27value&" +
                "r=https%3A%2F%2Frelay.example",
            AppLinkDestination.toWebClientUrl(
                "https://yepanywhere.com/open?u=user%2Bname&p=safe%27value&" +
                    "r=https%3A%2F%2Frelay.example",
                clientUrl,
            ),
        )
    }

    @Test
    fun rejectsUnapprovedOriginsPathsAndPorts() {
        for (
            url in listOf(
                "http://yepanywhere.com/open?u=user&p=password",
                "https://evil.example/open?u=user&p=password",
                "https://yepanywhere.com:444/open?u=user&p=password",
                "https://yepanywhere.com/open/extra?u=user&p=password",
            )
        ) {
            assertNull(AppLinkDestination.toWebClientUrl(url, clientUrl))
        }
    }

    @Test
    fun rejectsIncompleteOrMalformedCredentials() {
        for (
            url in listOf(
                "https://yepanywhere.com/open",
                "https://yepanywhere.com/open?u=user",
                "https://yepanywhere.com/open?u=user&p=",
                "https://yepanywhere.com/open?u=%ZZ&p=password",
                "https://yepanywhere.com/open?u=user&p=password#other",
            )
        ) {
            assertNull(AppLinkDestination.toWebClientUrl(url, clientUrl))
        }
    }
}
