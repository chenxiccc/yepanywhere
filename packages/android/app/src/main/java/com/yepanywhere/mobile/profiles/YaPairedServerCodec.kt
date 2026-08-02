package com.yepanywhere.mobile.profiles

import com.yepanywhere.mobile.connection.YaResumeCredential
import com.yepanywhere.mobile.connection.YaSecureTransportCrypto
import org.json.JSONArray
import org.json.JSONObject

internal object YaPairedServerCodec {
    fun encodeProfiles(profiles: List<YaPairedServerProfile>): String {
        require(profiles.map(YaPairedServerProfile::id).toSet().size == profiles.size)
        return JSONObject()
            .put("version", PROFILE_SCHEMA_VERSION)
            .put(
                "profiles",
                JSONArray().apply {
                    profiles.sortedBy(YaPairedServerProfile::createdAtEpochMs).forEach { profile ->
                        put(encodeProfile(profile))
                    }
                },
            )
            .toString()
    }

    fun decodeProfiles(encoded: String?): List<YaPairedServerProfile> {
        if (encoded == null) return emptyList()
        val root = JSONObject(encoded)
        check(root.length() == 2 && root.getInt("version") == PROFILE_SCHEMA_VERSION)
        val profiles = root.getJSONArray("profiles")
        return buildList(profiles.length()) {
            repeat(profiles.length()) { index -> add(decodeProfile(profiles.getJSONObject(index))) }
        }.also { decoded ->
            check(decoded.map(YaPairedServerProfile::id).toSet().size == decoded.size)
        }
    }

    fun encodeCredential(stored: YaStoredResumeCredential): ByteArray {
        val key = stored.credential.copyBaseKey()
        return try {
            JSONObject()
                .put("version", CREDENTIAL_SCHEMA_VERSION)
                .put("username", stored.credential.username)
                .put("sessionId", stored.credential.sessionId)
                .put("baseKey", YaSecureTransportCrypto.encodeBase64(key))
                .put("resumeProtocolVersion", stored.credential.resumeProtocolVersion)
                .put("establishedAtEpochMs", stored.establishedAtEpochMs)
                .put("lastResumedAtEpochMs", stored.lastResumedAtEpochMs ?: JSONObject.NULL)
                .toString()
                .toByteArray(Charsets.UTF_8)
        } finally {
            key.fill(0)
        }
    }

    fun decodeCredential(encoded: ByteArray): YaStoredResumeCredential {
        val root = JSONObject(encoded.toString(Charsets.UTF_8))
        check(
            root.length() == 7 &&
                root.getInt("version") == CREDENTIAL_SCHEMA_VERSION,
        )
        val baseKey = YaSecureTransportCrypto.decodeBase64(root.getString("baseKey"))
        return try {
            YaStoredResumeCredential(
                credential = YaResumeCredential(
                    username = root.getString("username"),
                    sessionId = root.getString("sessionId"),
                    baseKey = baseKey,
                    resumeProtocolVersion = root.getInt("resumeProtocolVersion"),
                ),
                establishedAtEpochMs = root.getLong("establishedAtEpochMs"),
                lastResumedAtEpochMs = if (root.isNull("lastResumedAtEpochMs")) {
                    null
                } else {
                    root.getLong("lastResumedAtEpochMs")
                },
            )
        } finally {
            baseKey.fill(0)
        }
    }

    private fun encodeProfile(profile: YaPairedServerProfile): JSONObject {
        return JSONObject()
            .put("id", profile.id)
            .put("label", profile.label)
            .put("username", profile.username)
            .put(
                "routes",
                JSONArray().apply {
                    profile.routes.forEach { route ->
                        put(
                            JSONObject()
                                .put("id", route.id)
                                .put("kind", route.kind.name.lowercase())
                                .put("websocketUrl", route.websocketUrl)
                                .put("relayTarget", route.relayTarget ?: JSONObject.NULL),
                        )
                    }
                },
            )
            .put("preferredRouteId", profile.preferredRouteId ?: JSONObject.NULL)
            .put("createdAtEpochMs", profile.createdAtEpochMs)
            .put("lastConnectedAtEpochMs", profile.lastConnectedAtEpochMs ?: JSONObject.NULL)
    }

    private fun decodeProfile(root: JSONObject): YaPairedServerProfile {
        check(
            root.length() == 7 &&
                root.has("id") &&
                root.has("label") &&
                root.has("username") &&
                root.has("routes") &&
                root.has("preferredRouteId") &&
                root.has("createdAtEpochMs") &&
                root.has("lastConnectedAtEpochMs"),
        )
        val routes = root.getJSONArray("routes")
        return YaPairedServerProfile(
            id = root.getString("id"),
            label = root.getString("label"),
            username = root.getString("username"),
            routes = buildList(routes.length()) {
                repeat(routes.length()) { index ->
                    val route = routes.getJSONObject(index)
                    check(route.length() == 4)
                    add(
                        YaServerRoute(
                            id = route.getString("id"),
                            kind = YaServerRouteKind.valueOf(
                                route.getString("kind").uppercase(),
                            ),
                            websocketUrl = route.getString("websocketUrl"),
                            relayTarget = if (route.isNull("relayTarget")) {
                                null
                            } else {
                                route.getString("relayTarget")
                            },
                        ),
                    )
                }
            },
            preferredRouteId = if (root.isNull("preferredRouteId")) {
                null
            } else {
                root.getString("preferredRouteId")
            },
            createdAtEpochMs = root.getLong("createdAtEpochMs"),
            lastConnectedAtEpochMs = if (root.isNull("lastConnectedAtEpochMs")) {
                null
            } else {
                root.getLong("lastConnectedAtEpochMs")
            },
        )
    }

    private const val PROFILE_SCHEMA_VERSION = 1
    private const val CREDENTIAL_SCHEMA_VERSION = 1
}
