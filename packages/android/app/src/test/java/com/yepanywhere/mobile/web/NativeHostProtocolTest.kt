package com.yepanywhere.mobile.web

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeHostProtocolTest {
    private val protocol = NativeHostProtocol(
        NativeHostDescriptor(
            platform = "android",
            appVersion = "0.1.0",
            buildVersion = 1000,
            features = emptyList(),
        ),
    )

    @Test
    fun describesTheHost() {
        val response = handle(
            """{"protocol":1,"id":"one","method":"host.describe"}""",
        )

        assertTrue(response.getBoolean("ok"))
        val result = response.getJSONObject("result")
        assertEquals(1, result.getInt("protocol"))
        assertEquals("android", result.getString("platform"))
        assertEquals("0.1.0", result.getString("appVersion"))
        assertEquals(1000, result.getLong("buildVersion"))
        assertEquals(0, result.getJSONArray("features").length())
    }

    @Test
    fun rejectsInvalidAndOversizedMessages() {
        assertError(null, "invalid_request")
        assertError("not-json", "invalid_request")
        assertError(
            """{"protocol":1,"id":7,"method":"host.describe"}""",
            "invalid_request",
        )
        assertError(
            """{"protocol":"1","id":"string-protocol","method":"host.describe"}""",
            "unsupported_protocol",
        )
        assertError(
            """{"protocol":1,"id":"number-method","method":7}""",
            "invalid_request",
        )
        assertError(
            """{"protocol":2,"id":"one","method":"host.describe"}""",
            "unsupported_protocol",
        )
        assertError("x".repeat(NativeHostProtocol.MAX_MESSAGE_BYTES + 1), "message_too_large")
    }

    @Test
    fun rejectsUnknownMethodsAndParams() {
        assertError(
            """{"protocol":1,"id":"one","method":"files.read"}""",
            "unknown_method",
        )
        assertError(
            """{"protocol":1,"id":"two","method":"host.describe","params":[]}""",
            "invalid_params",
        )
        assertError(
            """{"protocol":1,"id":"three","method":"host.describe","params":{"extra":true}}""",
            "invalid_params",
        )
    }

    @Test
    fun rejectsDuplicateIdsUntilTheDocumentChanges() {
        val request = """{"protocol":1,"id":"one","method":"host.describe"}"""
        assertTrue(handle(request).getBoolean("ok"))
        assertError(request, "duplicate_request")

        protocol.onDocumentChanged()
        assertTrue(handle(request).getBoolean("ok"))
    }

    private fun assertError(request: String?, expectedCode: String) {
        val response = handle(request)
        assertFalse(response.getBoolean("ok"))
        assertEquals(expectedCode, response.getJSONObject("error").getString("code"))
    }

    private fun handle(request: String?): JSONObject {
        return JSONObject(protocol.handle(request))
    }
}
