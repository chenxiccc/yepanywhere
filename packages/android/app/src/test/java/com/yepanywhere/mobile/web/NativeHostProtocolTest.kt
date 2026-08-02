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
            features = listOf("notifications.status"),
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
        assertEquals("notifications.status", result.getJSONArray("features").getString(0))
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
    fun dispatchesOnlyAdvertisedFeatureMethods() {
        val dispatch = protocol.handle(
            """{"protocol":1,"id":"one","method":"notifications.status"}""",
        )

        assertTrue(dispatch is NativeHostDispatch.Invoke)
        val invocation = (dispatch as NativeHostDispatch.Invoke).invocation
        assertEquals("one", invocation.id)
        assertEquals("notifications.status", invocation.method)
        assertEquals(0, invocation.params.length())
        val response = JSONObject(
            protocol.complete(
                invocation.id,
                NativeHostOperationResult.Success(JSONObject().put("permission", "granted")),
            ),
        )
        assertTrue(response.getBoolean("ok"))
        assertEquals("granted", response.getJSONObject("result").getString("permission"))
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
        val dispatch = protocol.handle(request)
        assertTrue(dispatch is NativeHostDispatch.Reply)
        return JSONObject((dispatch as NativeHostDispatch.Reply).message)
    }
}
