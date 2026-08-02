package com.yepanywhere.mobile.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class WebClientConfigTest {
    @Test
    fun normalizesOrigins() {
        assertEquals(
            "https://example.com",
            WebClientOrigin.parse("https://EXAMPLE.com:443/projects"),
        )
        assertEquals(
            "http://localhost:3403",
            WebClientOrigin.parse("http://localhost:3403/"),
        )
    }

    @Test
    fun rejectsNonNetworkAndCredentialedUrls() {
        assertThrows(IllegalArgumentException::class.java) {
            WebClientOrigin.parse("file:///tmp/index.html")
        }
        assertThrows(IllegalArgumentException::class.java) {
            WebClientOrigin.parse("https://user@example.com/")
        }
    }
}
