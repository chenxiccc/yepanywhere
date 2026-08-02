package com.yepanywhere.mobile.security

import com.yepanywhere.mobile.connection.YaApiResponse
import com.yepanywhere.mobile.connection.YaMessageTransport
import com.yepanywhere.mobile.profiles.YaPairedServerProfile
import com.yepanywhere.mobile.profiles.YaPairedServerRepository
import com.yepanywhere.mobile.profiles.YaSecurityClientBinding
import java.util.UUID
import kotlinx.coroutines.withTimeout
import org.json.JSONObject

fun interface YaSecurityClientLifecycle {
    suspend fun ensure(
        profile: YaPairedServerProfile,
        transport: YaMessageTransport,
    ): YaPairedServerProfile
}

class YaSecurityClientRevokedException(val clientId: String) :
    IllegalStateException("This Android security client was revoked")

class YaSecurityClientCoordinator(
    private val repository: YaPairedServerRepository,
    private val keys: YaSecurityClientKeyStore,
    private val descriptors: YaSecurityClientDescriptorProvider,
) : YaSecurityClientLifecycle {
    override suspend fun ensure(
        profile: YaPairedServerProfile,
        transport: YaMessageTransport,
    ): YaPairedServerProfile {
        val proofTransport = checkNotNull(transport.securityBinding) {
            "Security-client registration requires an established SRP transport"
        }
        var binding = profile.securityClient ?: YaSecurityClientBinding.pending(
            YaSecurityClientProtocol.keyAlias(profile.id),
        ).also { repository.updateSecurityClientBinding(profile.id, it) }
        if (binding.revoked) {
            throw YaSecurityClientRevokedException(checkNotNull(binding.clientId))
        }

        val version = request(transport, "GET", "/api/version")
        check(version.status == 200) { "YA version request failed with ${version.status}" }
        val capabilities = (version.body as? JSONObject)?.optJSONArray("capabilities")
        val supported = capabilities != null &&
            (0 until capabilities.length()).any {
                capabilities.optString(it) == YaSecurityClientProtocol.CAPABILITY
            }
        if (!supported) {
            if (!binding.capabilityMissing) {
                binding = binding.copy(capabilityMissing = true)
                repository.updateSecurityClientBinding(profile.id, binding)
            }
            return profile.copy(securityClient = binding)
        }
        if (binding.capabilityMissing) {
            binding = binding.copy(capabilityMissing = false)
            repository.updateSecurityClientBinding(profile.id, binding)
        }

        val keyAlias = checkNotNull(binding.keyAlias)
        keys.ensureKey(keyAlias)
        return if (binding.clientId == null) {
            register(profile.copy(securityClient = binding), transport, proofTransport)
        } else {
            checkIn(profile.copy(securityClient = binding), transport, proofTransport)
        }
    }

    private suspend fun register(
        profile: YaPairedServerProfile,
        transport: YaMessageTransport,
        proofTransport: com.yepanywhere.mobile.connection.YaSrpTransportBinding,
    ): YaPairedServerProfile {
        val binding = checkNotNull(profile.securityClient)
        val keyAlias = checkNotNull(binding.keyAlias)
        val requestId = checkNotNull(binding.pendingRequestId)
        val publicKey = keys.publicKeySpki(keyAlias)
        val publicKeyBase64 = YaSecurityClientProtocol.publicKeyBase64Url(publicKey)
        val descriptor = descriptors.descriptor(profile)
        val proofBody = YaSecurityClientProtocol.registerProofBody(
            requestId = requestId,
            label = profile.label,
            descriptor = descriptor,
            publicKeySpki = publicKeyBase64,
        )
        val signature = YaSecurityClientProtocol.sign(
            keys = keys,
            keyAlias = keyAlias,
            operation = "register",
            route = YaSecurityClientProtocol.REGISTER_ROUTE,
            subjectId = requestId,
            proofBody = proofBody,
            transport = proofTransport,
        )
        val response = request(
            transport,
            "POST",
            YaSecurityClientProtocol.REGISTER_ROUTE,
            YaSecurityClientProtocol.registerRequest(proofBody, signature),
        )
        requireSuccessful(response)
        val client = response.client()
        assertFingerprint(client, YaSecurityClientProtocol.fingerprint(publicKey))
        val registered = YaSecurityClientBinding.registered(
            keyAlias = keyAlias,
            clientId = client.getString("clientId"),
        )
        repository.updateSecurityClientBinding(profile.id, registered)
        return profile.copy(securityClient = registered)
    }

    private suspend fun checkIn(
        profile: YaPairedServerProfile,
        transport: YaMessageTransport,
        proofTransport: com.yepanywhere.mobile.connection.YaSrpTransportBinding,
    ): YaPairedServerProfile {
        val binding = checkNotNull(profile.securityClient)
        val keyAlias = checkNotNull(binding.keyAlias)
        val clientId = checkNotNull(binding.clientId)
        val descriptor = descriptors.descriptor(profile)
        val proofBody = YaSecurityClientProtocol.checkInProofBody(descriptor)
        val route = YaSecurityClientProtocol.checkInRoute(clientId)
        val signature = YaSecurityClientProtocol.sign(
            keys = keys,
            keyAlias = keyAlias,
            operation = "check-in",
            route = route,
            subjectId = clientId,
            proofBody = proofBody,
            transport = proofTransport,
        )
        val response = request(
            transport,
            "POST",
            route,
            YaSecurityClientProtocol.checkInRequest(proofBody, signature),
        )
        when (response.errorCode()) {
            "security_client_unknown" -> {
                val pending = YaSecurityClientBinding.pending(
                    keyAlias = keyAlias,
                    requestId = UUID.randomUUID().toString(),
                )
                repository.updateSecurityClientBinding(profile.id, pending)
                return register(profile.copy(securityClient = pending), transport, proofTransport)
            }
            "security_client_revoked" -> {
                repository.markSecurityClientRevoked(profile.id, clientId)
                runCatching { keys.delete(keyAlias) }
                throw YaSecurityClientRevokedException(clientId)
            }
        }
        requireSuccessful(response)
        assertFingerprint(
            response.client(),
            YaSecurityClientProtocol.fingerprint(keys.publicKeySpki(keyAlias)),
        )
        return profile.copy(securityClient = binding.copy(capabilityMissing = false))
    }

    private fun assertFingerprint(client: JSONObject, expected: String) {
        val proofs = client.getJSONArray("proofs")
        val continuityProof = (0 until proofs.length())
            .map { proofs.getJSONObject(it) }
            .firstOrNull { it.optString("type") == "continuity-key" }
            ?: error("YA security-client response omitted the continuity proof")
        check(continuityProof.getString("keyFingerprint") == expected) {
            "YA security-client key fingerprint did not match Android Keystore"
        }
    }

    private fun requireSuccessful(response: YaApiResponse) {
        check(response.status in 200..299) {
            val body = response.body as? JSONObject
            body?.optString("error")?.takeIf(String::isNotBlank)
                ?: "YA security-client request failed with ${response.status}"
        }
    }

    private fun YaApiResponse.client(): JSONObject {
        return checkNotNull(checkNotNull(body as? JSONObject).getJSONObject("client"))
    }

    private fun YaApiResponse.errorCode(): String? {
        if (status < 400) return null
        return (body as? JSONObject)?.optString("code")?.takeIf(String::isNotBlank)
    }

    private suspend fun request(
        transport: YaMessageTransport,
        method: String,
        path: String,
        body: JSONObject? = null,
    ): YaApiResponse {
        val requestId = UUID.randomUUID().toString()
        val message = JSONObject()
            .put("type", "request")
            .put("id", requestId)
            .put("method", method)
            .put("path", path)
            .put(
                "headers",
                JSONObject()
                    .put("Content-Type", "application/json")
                    .put("X-Yep-Anywhere", "true"),
            )
        if (body != null) message.put("body", body)
        transport.send(message)
        return withTimeout(REQUEST_TIMEOUT_MS) {
            repeat(MAX_MESSAGES_BEFORE_RESPONSE) {
                val response = transport.receive()
                if (
                    response.optString("type") == "response" &&
                    response.optString("id") == requestId
                ) {
                    return@withTimeout response.toApiResponse()
                }
            }
            error("YA security-client response was not received within the message bound")
        }
    }

    private fun JSONObject.toApiResponse(): YaApiResponse {
        val headersObject = optJSONObject("headers")
        val headers = if (headersObject == null) {
            emptyMap()
        } else {
            buildMap {
                headersObject.keys().forEach { key -> put(key, headersObject.getString(key)) }
            }
        }
        return YaApiResponse(
            status = getInt("status"),
            headers = headers,
            body = if (!has("body") || isNull("body")) null else get("body"),
        )
    }

    companion object {
        private const val REQUEST_TIMEOUT_MS = 30_000L
        private const val MAX_MESSAGES_BEFORE_RESPONSE = 32
    }
}
