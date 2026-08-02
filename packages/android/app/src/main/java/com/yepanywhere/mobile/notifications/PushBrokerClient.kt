package com.yepanywhere.mobile.notifications

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import org.json.JSONObject

data class BrokerInstallationCredentials(
    val installationId: String,
    val installationSecret: String,
)

sealed interface CreateInstallationResult {
    data class Created(val credentials: BrokerInstallationCredentials) :
        CreateInstallationResult

    data object Failed : CreateInstallationResult
}

enum class ReplaceInstallationTargetResult {
    UPDATED,
    NOT_FOUND,
    FAILED,
}

interface PushBrokerApi {
    fun createInstallation(fid: String): CreateInstallationResult
    fun replaceInstallationTarget(
        credentials: BrokerInstallationCredentials,
        fid: String,
    ): ReplaceInstallationTargetResult

    fun deleteInstallation(credentials: BrokerInstallationCredentials)
}

class PushBrokerClient internal constructor(
    endpoint: String,
    private val connectionFactory: (URL) -> HttpURLConnection = { url ->
        url.openConnection() as HttpURLConnection
    },
) : PushBrokerApi {
    private val endpoint = parseEndpoint(endpoint)

    override fun createInstallation(fid: String): CreateInstallationResult {
        if (!isValidFid(fid)) return CreateInstallationResult.Failed
        val response = request(
            method = "POST",
            path = "v1/installations",
            bearerSecret = null,
            body = installationBody(fid),
        ) ?: return CreateInstallationResult.Failed
        if (response.status != HttpURLConnection.HTTP_CREATED || response.body == null) {
            return CreateInstallationResult.Failed
        }
        val credentials = runCatching { parseCredentials(JSONObject(response.body)) }.getOrNull()
            ?: return CreateInstallationResult.Failed
        return CreateInstallationResult.Created(credentials)
    }

    override fun replaceInstallationTarget(
        credentials: BrokerInstallationCredentials,
        fid: String,
    ): ReplaceInstallationTargetResult {
        if (!isValidCredentials(credentials) || !isValidFid(fid)) {
            return ReplaceInstallationTargetResult.FAILED
        }
        val response = request(
            method = "PUT",
            path = "v1/installations/${credentials.installationId}/target",
            bearerSecret = credentials.installationSecret,
            body = installationBody(fid),
        ) ?: return ReplaceInstallationTargetResult.FAILED
        return when (response.status) {
            HttpURLConnection.HTTP_NO_CONTENT -> ReplaceInstallationTargetResult.UPDATED
            HttpURLConnection.HTTP_NOT_FOUND -> ReplaceInstallationTargetResult.NOT_FOUND
            else -> ReplaceInstallationTargetResult.FAILED
        }
    }

    override fun deleteInstallation(credentials: BrokerInstallationCredentials) {
        if (!isValidCredentials(credentials)) return
        request(
            method = "DELETE",
            path = "v1/installations/${credentials.installationId}",
            bearerSecret = credentials.installationSecret,
            body = null,
        )
    }

    private fun request(
        method: String,
        path: String,
        bearerSecret: String?,
        body: String?,
    ): BrokerHttpResponse? {
        return try {
            val connection = connectionFactory(endpoint.resolve(path).toURL())
            try {
                connection.requestMethod = method
                connection.connectTimeout = CONNECT_TIMEOUT_MS
                connection.readTimeout = READ_TIMEOUT_MS
                connection.instanceFollowRedirects = false
                connection.setRequestProperty("Accept", "application/json")
                connection.setRequestProperty("Cache-Control", "no-store")
                if (bearerSecret != null) {
                    connection.setRequestProperty("Authorization", "Bearer $bearerSecret")
                }
                if (body != null) {
                    val bytes = body.toByteArray(Charsets.UTF_8)
                    connection.doOutput = true
                    connection.setFixedLengthStreamingMode(bytes.size)
                    connection.setRequestProperty("Content-Type", "application/json")
                    connection.outputStream.use { output -> output.write(bytes) }
                }
                val status = connection.responseCode
                val responseBody = if (status == HttpURLConnection.HTTP_CREATED) {
                    connection.inputStream.use { input ->
                        readBounded(input).toString(Charsets.UTF_8)
                    }
                } else {
                    null
                }
                BrokerHttpResponse(status, responseBody)
            } finally {
                connection.disconnect()
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun installationBody(fid: String): String {
        return JSONObject()
            .put(
                "target",
                JSONObject()
                    .put("provider", "fcm")
                    .put("kind", "fid")
                    .put("value", fid),
            )
            .toString()
    }

    private fun parseCredentials(value: JSONObject): BrokerInstallationCredentials {
        check(
            value.length() == 2 &&
                value.has("installationId") &&
                value.has("installationSecret"),
        )
        return BrokerInstallationCredentials(
            installationId = value.getString("installationId"),
            installationSecret = value.getString("installationSecret"),
        ).also { check(isValidCredentials(it)) }
    }

    private data class BrokerHttpResponse(val status: Int, val body: String?)

    companion object {
        private const val CONNECT_TIMEOUT_MS = 3_000
        private const val READ_TIMEOUT_MS = 5_000
        private const val MAX_RESPONSE_BYTES = 8 * 1024
        private val INSTALLATION_ID_PATTERN = Regex("^[A-Za-z0-9_-]{22}$")
        private val INSTALLATION_SECRET_PATTERN = Regex("^[A-Za-z0-9_-]{43}$")

        private fun parseEndpoint(value: String): URI {
            val uri = URI(value)
            require(uri.scheme == "https" && uri.host != null && uri.userInfo == null)
            require(uri.rawQuery == null && uri.rawFragment == null)
            require(uri.path.isNullOrEmpty() || uri.path == "/")
            return if (uri.path == "/") uri else URI("$value/")
        }

        private fun isValidCredentials(credentials: BrokerInstallationCredentials): Boolean {
            return INSTALLATION_ID_PATTERN.matches(credentials.installationId) &&
                INSTALLATION_SECRET_PATTERN.matches(credentials.installationSecret)
        }

        private fun isValidFid(fid: String): Boolean {
            return fid.isNotEmpty() &&
                fid.length <= 4096 &&
                fid.trim() == fid &&
                fid.none { it.code in 0..31 || it.code == 127 }
        }

        private fun readBounded(input: InputStream): ByteArray {
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                check(output.size() + read <= MAX_RESPONSE_BYTES)
                output.write(buffer, 0, read)
            }
            return output.toByteArray()
        }
    }
}
