package com.yepanywhere.mobile.security

import com.yepanywhere.mobile.connection.YaSrpTransportBinding
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.UUID
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject

internal object YaSecurityClientProtocol {
    const val CAPABILITY = "security-client-audit-v1"
    const val REGISTER_ROUTE = "/api/security/clients/register"
    const val KEY_PROTOCOL = "client-key-p256-v1"
    const val PROOF_DOMAIN = "yep-security-client-key-v1"
    const val DESCRIPTOR_VERSION = 1

    fun keyAlias(profileId: String): String {
        UUID.fromString(profileId)
        return "ya_security_client_p256_v1_$profileId"
    }

    fun checkInRoute(clientId: String): String {
        UUID.fromString(clientId)
        return "/api/security/clients/$clientId/check-in"
    }

    fun publicKeyBase64Url(publicKeySpki: ByteArray): String =
        publicKeySpki.toByteString().base64Url().trimEnd('=')

    fun fingerprint(publicKeySpki: ByteArray): String =
        sha256(publicKeySpki).toByteString().base64Url().trimEnd('=')

    fun signatureBase64Url(signature: ByteArray): String =
        signature.toByteString().base64Url().trimEnd('=')

    fun registerProofBody(
        requestId: String,
        label: String,
        descriptor: JSONObject,
        publicKeySpki: String,
    ): JSONObject = JSONObject()
        .put("descriptor", descriptor)
        .put("descriptorVersion", DESCRIPTOR_VERSION)
        .put(
            "key",
            JSONObject()
                .put("protocol", KEY_PROTOCOL)
                .put("publicKeySpki", publicKeySpki)
                .put("reportedStorage", "android-keystore"),
        )
        .put("kind", "android-native")
        .put("label", label)
        .put("requestId", requestId)

    fun checkInProofBody(descriptor: JSONObject): JSONObject = JSONObject()
        .put("descriptor", descriptor)
        .put("descriptorVersion", DESCRIPTOR_VERSION)

    fun registerRequest(proofBody: JSONObject, signature: String): JSONObject {
        val key = JSONObject(proofBody.getJSONObject("key").toString())
            .put("signature", signature)
        return JSONObject(proofBody.toString()).put("key", key)
    }

    fun checkInRequest(proofBody: JSONObject, signature: String): JSONObject =
        JSONObject(proofBody.toString()).put("signature", signature)

    fun sign(
        keys: YaSecurityClientKeyStore,
        keyAlias: String,
        operation: String,
        route: String,
        subjectId: String,
        proofBody: JSONObject,
        transport: YaSrpTransportBinding,
    ): String {
        val bodyDigest = sha256(canonicalize(proofBody).toByteArray(Charsets.UTF_8))
        val transcript = transcript(
            operation = operation,
            route = route,
            sessionId = transport.sessionId,
            transportNonce = transport.transportNonce,
            subjectId = subjectId,
            bodyDigest = bodyDigest,
        )
        return signatureBase64Url(keys.sign(keyAlias, transcript))
    }

    fun canonicalize(value: Any?): String {
        return when (value) {
            null, JSONObject.NULL -> "null"
            is String -> JSONObject.quote(value)
            is Boolean -> value.toString()
            is Number -> {
                require(value.toDouble().isFinite()) { "Cannot canonicalize a non-finite number" }
                JSONObject.numberToString(value)
            }
            is JSONArray -> buildString {
                append('[')
                repeat(value.length()) { index ->
                    if (index > 0) append(',')
                    append(canonicalize(value.get(index)))
                }
                append(']')
            }
            is JSONObject -> buildString {
                append('{')
                value.keys().asSequence().toList().sorted().forEachIndexed { index, key ->
                    if (index > 0) append(',')
                    append(JSONObject.quote(key))
                    append(':')
                    append(canonicalize(value.get(key)))
                }
                append('}')
            }
            else -> error("Cannot canonicalize ${value::class.java.simpleName}")
        }
    }

    fun transcript(
        operation: String,
        route: String,
        sessionId: String,
        transportNonce: String,
        subjectId: String,
        bodyDigest: ByteArray,
    ): ByteArray {
        require(bodyDigest.size == 32) { "Security-client proof body digest must be 32 bytes" }
        val parts = listOf(
            PROOF_DOMAIN.toByteArray(Charsets.UTF_8),
            operation.toByteArray(Charsets.UTF_8),
            route.toByteArray(Charsets.UTF_8),
            sessionId.toByteArray(Charsets.UTF_8),
            transportNonce.toByteArray(Charsets.UTF_8),
            subjectId.toByteArray(Charsets.UTF_8),
            bodyDigest,
        )
        return ByteArrayOutputStream().use { output ->
            parts.forEach { part ->
                output.write((part.size ushr 24) and 0xff)
                output.write((part.size ushr 16) and 0xff)
                output.write((part.size ushr 8) and 0xff)
                output.write(part.size and 0xff)
                output.write(part)
            }
            output.toByteArray()
        }
    }

    private fun sha256(value: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(value)
}
