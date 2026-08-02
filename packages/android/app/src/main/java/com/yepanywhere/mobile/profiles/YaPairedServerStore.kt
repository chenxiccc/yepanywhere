package com.yepanywhere.mobile.profiles

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import com.yepanywhere.mobile.security.YaSecurityClientKeyStore
import java.io.Closeable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

class YaPairedServerStore internal constructor(
    private val dataStore: DataStore<Preferences>,
    private val cipher: YaResumeCredentialCipher,
    private val securityKeys: YaSecurityClientKeyStore? = null,
    private val ownedScope: CoroutineScope? = null,
) : YaPairedServerRepository, Closeable {
    val profiles: Flow<List<YaPairedServerProfile>> = dataStore.data.map { preferences ->
        YaPairedServerCodec.decodeProfiles(preferences[PROFILES_KEY])
    }

    val selectedProfileId: Flow<String?> = dataStore.data.map { preferences ->
        preferences[SELECTED_PROFILE_KEY]
    }

    suspend fun snapshots(): List<YaPairedServerSnapshot> {
        val preferences = dataStore.data.first()
        return YaPairedServerCodec.decodeProfiles(preferences[PROFILES_KEY]).map { profile ->
            YaPairedServerSnapshot(
                profile = profile,
                resumeCredential = decodeCredential(preferences, profile),
            )
        }
    }

    override suspend fun snapshot(profileId: String): YaPairedServerSnapshot? {
        requireUuid(profileId, "profile id")
        return snapshots().firstOrNull { it.profile.id == profileId }
    }

    override suspend fun upsert(
        profile: YaPairedServerProfile,
        resumeCredential: YaStoredResumeCredential?,
        select: Boolean,
    ) {
        require(resumeCredential == null || resumeCredential.credential.username == profile.username)
        val encryptedCredential = resumeCredential?.let { stored ->
            val plaintext = YaPairedServerCodec.encodeCredential(stored)
            try {
                cipher.encrypt(profile.id, plaintext)
            } finally {
                plaintext.fill(0)
            }
        }
        dataStore.edit { preferences ->
            val current = YaPairedServerCodec.decodeProfiles(preferences[PROFILES_KEY])
            val previous = current.firstOrNull { it.id == profile.id }
            val updated = current.filterNot { it.id == profile.id } + profile
            preferences[PROFILES_KEY] = YaPairedServerCodec.encodeProfiles(updated)
            if (encryptedCredential != null) {
                preferences[credentialKey(profile.id)] = encryptedCredential
            } else if (previous != null && previous.username != profile.username) {
                preferences.remove(credentialKey(profile.id))
            }
            if (select) preferences[SELECTED_PROFILE_KEY] = profile.id
        }
    }

    suspend fun updateCredential(
        profileId: String,
        resumeCredential: YaStoredResumeCredential,
    ) {
        requireUuid(profileId, "profile id")
        val plaintext = YaPairedServerCodec.encodeCredential(resumeCredential)
        val encrypted = try {
            cipher.encrypt(profileId, plaintext)
        } finally {
            plaintext.fill(0)
        }
        dataStore.edit { preferences ->
            val profile = YaPairedServerCodec.decodeProfiles(preferences[PROFILES_KEY])
                .firstOrNull { it.id == profileId }
                ?: error("Cannot store a credential for an unknown profile")
            require(profile.username == resumeCredential.credential.username)
            preferences[credentialKey(profileId)] = encrypted
        }
    }

    override suspend fun clearCredential(profileId: String) {
        requireUuid(profileId, "profile id")
        dataStore.edit { it.remove(credentialKey(profileId)) }
    }

    override suspend fun updateSecurityClientBinding(
        profileId: String,
        binding: YaSecurityClientBinding,
    ) {
        requireUuid(profileId, "profile id")
        dataStore.edit { preferences ->
            val profiles = YaPairedServerCodec.decodeProfiles(preferences[PROFILES_KEY])
            check(profiles.any { it.id == profileId }) {
                "Cannot update an unknown profile"
            }
            preferences[PROFILES_KEY] = YaPairedServerCodec.encodeProfiles(
                profiles.map {
                    if (it.id == profileId) it.copy(securityClient = binding) else it
                },
            )
        }
    }

    override suspend fun markSecurityClientRevoked(profileId: String, clientId: String) {
        requireUuid(profileId, "profile id")
        requireUuid(clientId, "security client id")
        dataStore.edit { preferences ->
            val profiles = YaPairedServerCodec.decodeProfiles(preferences[PROFILES_KEY])
            val profile = profiles.firstOrNull { it.id == profileId }
                ?: error("Cannot revoke an unknown profile")
            check(profile.securityClient?.clientId == clientId) {
                "Cannot revoke a different security client"
            }
            preferences[PROFILES_KEY] = YaPairedServerCodec.encodeProfiles(
                profiles.map {
                    if (it.id == profileId) {
                        it.copy(securityClient = YaSecurityClientBinding.revoked(clientId))
                    } else {
                        it
                    }
                },
            )
            preferences.remove(credentialKey(profileId))
        }
    }

    suspend fun select(profileId: String?) {
        if (profileId != null) requireUuid(profileId, "profile id")
        dataStore.edit { preferences ->
            if (profileId == null) {
                preferences.remove(SELECTED_PROFILE_KEY)
            } else {
                check(
                    YaPairedServerCodec.decodeProfiles(preferences[PROFILES_KEY])
                        .any { it.id == profileId },
                ) { "Cannot select an unknown profile" }
                preferences[SELECTED_PROFILE_KEY] = profileId
            }
        }
    }

    suspend fun forget(profileId: String) {
        requireUuid(profileId, "profile id")
        var keyAlias: String? = null
        dataStore.edit { preferences ->
            val profiles = YaPairedServerCodec.decodeProfiles(preferences[PROFILES_KEY])
            keyAlias = profiles.firstOrNull { it.id == profileId }?.securityClient?.keyAlias
            val updated = profiles
                .filterNot { it.id == profileId }
            preferences[PROFILES_KEY] = YaPairedServerCodec.encodeProfiles(updated)
            preferences.remove(credentialKey(profileId))
            if (preferences[SELECTED_PROFILE_KEY] == profileId) {
                preferences.remove(SELECTED_PROFILE_KEY)
            }
        }
        keyAlias?.let { securityKeys?.delete(it) }
    }

    override suspend fun recordSuccessfulAuthentication(
        profileId: String,
        routeId: String,
        resumeCredential: YaStoredResumeCredential,
        connectedAtEpochMs: Long,
    ) {
        requireUuid(profileId, "profile id")
        requireUuid(routeId, "route id")
        require(connectedAtEpochMs >= 0)
        val plaintext = YaPairedServerCodec.encodeCredential(resumeCredential)
        val encrypted = try {
            cipher.encrypt(profileId, plaintext)
        } finally {
            plaintext.fill(0)
        }
        dataStore.edit { preferences ->
            val profiles = YaPairedServerCodec.decodeProfiles(preferences[PROFILES_KEY])
            val profile = profiles.firstOrNull { it.id == profileId }
                ?: error("Cannot update an unknown profile")
            require(profile.username == resumeCredential.credential.username)
            require(profile.routes.any { it.id == routeId })
            val updated = profile.copy(
                preferredRouteId = routeId,
                lastConnectedAtEpochMs = connectedAtEpochMs,
            )
            preferences[PROFILES_KEY] = YaPairedServerCodec.encodeProfiles(
                profiles.map { if (it.id == profileId) updated else it },
            )
            preferences[credentialKey(profileId)] = encrypted
        }
    }

    override fun close() {
        ownedScope?.cancel()
    }

    private fun decodeCredential(
        preferences: Preferences,
        profile: YaPairedServerProfile,
    ): YaStoredResumeCredential? {
        val envelope = preferences[credentialKey(profile.id)] ?: return null
        val plaintext = cipher.decrypt(profile.id, envelope) ?: return null
        return try {
            runCatching { YaPairedServerCodec.decodeCredential(plaintext) }
                .getOrNull()
                ?.takeIf { it.credential.username == profile.username }
        } finally {
            plaintext.fill(0)
        }
    }

    companion object {
        private val PROFILES_KEY = stringPreferencesKey("profiles_v2")
        private val SELECTED_PROFILE_KEY = stringPreferencesKey("selected_profile_v2")
        private const val DATA_STORE_FILE_NAME = "ya_paired_servers_v2"

        fun create(
            context: Context,
            fileName: String = DATA_STORE_FILE_NAME,
            keyAlias: String = "ya_paired_server_resume_key_v2",
            securityKeys: YaSecurityClientKeyStore? = null,
        ): YaPairedServerStore {
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            val dataStore = PreferenceDataStoreFactory.create(
                scope = scope,
                produceFile = { context.applicationContext.preferencesDataStoreFile(fileName) },
            )
            return YaPairedServerStore(
                dataStore = dataStore,
                cipher = AndroidKeystoreResumeCredentialCipher(keyAlias),
                securityKeys = securityKeys,
                ownedScope = scope,
            )
        }

        private fun credentialKey(profileId: String): Preferences.Key<String> {
            return stringPreferencesKey("resume_credential_v2_$profileId")
        }
    }
}
