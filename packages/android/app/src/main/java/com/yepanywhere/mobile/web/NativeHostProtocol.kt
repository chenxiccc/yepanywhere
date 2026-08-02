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

data class NativeHostInvocation(
    val id: String,
    val method: String,
    val params: JSONObject,
)

sealed interface NativeHostDispatch {
    data class Reply(val message: String) : NativeHostDispatch
    data class Invoke(val invocation: NativeHostInvocation) : NativeHostDispatch
}

sealed interface NativeHostOperationResult {
    data class Success(val result: JSONObject) : NativeHostOperationResult
    data class Error(val code: String, val message: String) : NativeHostOperationResult
}

interface NativeHostOperations {
    val features: List<String>

    fun invoke(
        method: String,
        params: JSONObject,
        complete: (NativeHostOperationResult) -> Unit,
    )
}

class NativeHostProtocol(
    private val descriptor: NativeHostDescriptor,
) {
    private val requestIds = mutableSetOf<String>()
    private val supportedMethods = descriptor.features.toSet()

    fun onDocumentChanged() {
        requestIds.clear()
    }

    fun handle(rawMessage: String?): NativeHostDispatch {
        if (rawMessage == null) {
            return replyWithError("", "invalid_request", "Request must be a string")
        }
        if (rawMessage.toByteArray(Charsets.UTF_8).size > MAX_MESSAGE_BYTES) {
            return replyWithError("", "message_too_large", "Message exceeds 16 KiB")
        }

        val request = try {
            JSONObject(rawMessage)
        } catch (_: JSONException) {
            return replyWithError("", "invalid_request", "Request must be a JSON object")
        }

        val id = request.opt("id") as? String
        if (id.isNullOrEmpty() || id.length > MAX_ID_LENGTH) {
            return replyWithError("", "invalid_request", "Request id is invalid")
        }
        val requestedProtocol = request.opt("protocol") as? Number
        if (
            requestedProtocol == null ||
            requestedProtocol.toInt() != PROTOCOL_VERSION ||
            requestedProtocol.toDouble() != PROTOCOL_VERSION.toDouble()
        ) {
            return replyWithError(
                id,
                "unsupported_protocol",
                "Protocol version is unsupported",
            )
        }
        val method = request.opt("method") as? String
        if (method.isNullOrEmpty() || method.length > MAX_METHOD_LENGTH) {
            return replyWithError(id, "invalid_request", "Method is invalid")
        }
        if (!requestIds.add(id)) {
            return replyWithError(id, "duplicate_request", "Request id was already used")
        }

        if (request.has("params") && request.opt("params") !is JSONObject) {
            return replyWithError(id, "invalid_params", "Params must be an object")
        }
        val params = request.optJSONObject("params") ?: JSONObject()

        return when {
            method == "host.describe" -> describe(params, id)
            method in supportedMethods -> NativeHostDispatch.Invoke(
                NativeHostInvocation(id, method, params),
            )
            else -> replyWithError(id, "unknown_method", "Method is not supported")
        }
    }

    fun complete(id: String, result: NativeHostOperationResult): String {
        return when (result) {
            is NativeHostOperationResult.Success -> successResponse(id, result.result)
            is NativeHostOperationResult.Error -> errorResponse(id, result.code, result.message)
        }
    }

    private fun describe(params: JSONObject, id: String): NativeHostDispatch {
        if (params.length() != 0) {
            return replyWithError(id, "invalid_params", "host.describe takes no params")
        }

        val result = JSONObject()
            .put("protocol", PROTOCOL_VERSION)
            .put("platform", descriptor.platform)
            .put("appVersion", descriptor.appVersion)
            .put("buildVersion", descriptor.buildVersion)
            .put("features", JSONArray(descriptor.features))
        return NativeHostDispatch.Reply(successResponse(id, result))
    }

    private fun replyWithError(
        id: String,
        code: String,
        message: String,
    ): NativeHostDispatch.Reply {
        return NativeHostDispatch.Reply(errorResponse(id, code, message))
    }

    private fun successResponse(id: String, result: JSONObject): String {
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
