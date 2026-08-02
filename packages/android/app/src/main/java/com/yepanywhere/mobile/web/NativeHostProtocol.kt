package com.yepanywhere.mobile.web

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

data class NativeHostDescriptor(
    val platform: String,
    val appVersion: String,
    val buildVersion: Long,
    val features: List<String>,
)

class NativeHostProtocol(
    private val descriptor: NativeHostDescriptor,
) {
    private val requestIds = mutableSetOf<String>()

    fun onDocumentChanged() {
        requestIds.clear()
    }

    fun handle(rawMessage: String?): String {
        if (rawMessage == null) {
            return errorResponse("", "invalid_request", "Request must be a string")
        }
        if (rawMessage.toByteArray(Charsets.UTF_8).size > MAX_MESSAGE_BYTES) {
            return errorResponse("", "message_too_large", "Message exceeds 16 KiB")
        }

        val request = try {
            JSONObject(rawMessage)
        } catch (_: JSONException) {
            return errorResponse("", "invalid_request", "Request must be a JSON object")
        }

        val id = request.opt("id") as? String
        if (id.isNullOrEmpty() || id.length > MAX_ID_LENGTH) {
            return errorResponse("", "invalid_request", "Request id is invalid")
        }
        val requestedProtocol = request.opt("protocol") as? Number
        if (
            requestedProtocol == null ||
            requestedProtocol.toInt() != PROTOCOL_VERSION ||
            requestedProtocol.toDouble() != PROTOCOL_VERSION.toDouble()
        ) {
            return errorResponse(id, "unsupported_protocol", "Protocol version is unsupported")
        }
        val method = request.opt("method") as? String
        if (method.isNullOrEmpty() || method.length > MAX_METHOD_LENGTH) {
            return errorResponse(id, "invalid_request", "Method is invalid")
        }
        if (!requestIds.add(id)) {
            return errorResponse(id, "duplicate_request", "Request id was already used")
        }

        if (request.has("params") && request.opt("params") !is JSONObject) {
            return errorResponse(id, "invalid_params", "Params must be an object")
        }

        return when (method) {
            "host.describe" -> describe(request, id)
            else -> errorResponse(id, "unknown_method", "Method is not supported")
        }
    }

    private fun describe(request: JSONObject, id: String): String {
        val params = request.optJSONObject("params")
        if (params != null && params.length() != 0) {
            return errorResponse(id, "invalid_params", "host.describe takes no params")
        }

        val result = JSONObject()
            .put("protocol", PROTOCOL_VERSION)
            .put("platform", descriptor.platform)
            .put("appVersion", descriptor.appVersion)
            .put("buildVersion", descriptor.buildVersion)
            .put("features", JSONArray(descriptor.features))
        return JSONObject()
            .put("protocol", PROTOCOL_VERSION)
            .put("id", id)
            .put("ok", true)
            .put("result", result)
            .toString()
    }

    private fun errorResponse(id: String, code: String, message: String): String {
        return JSONObject()
            .put("protocol", PROTOCOL_VERSION)
            .put("id", id)
            .put("ok", false)
            .put(
                "error",
                JSONObject()
                    .put("code", code)
                    .put("message", message),
            )
            .toString()
    }

    companion object {
        const val PROTOCOL_VERSION = 1
        const val MAX_MESSAGE_BYTES = 16 * 1024
        private const val MAX_ID_LENGTH = 128
        private const val MAX_METHOD_LENGTH = 128
    }
}
