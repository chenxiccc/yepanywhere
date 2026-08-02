package com.yepanywhere.mobile.notifications

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

data class BrokerInstallationRecord(
    val installationId: String,
    val installationSecret: String,
    val targetDigest: String,
    val targetCurrent: Boolean,
)

interface BrokerInstallationStorage {
    fun read(): BrokerInstallationRecord?
    fun write(record: BrokerInstallationRecord)
    fun clear()
}

class BrokerInstallationStore internal constructor(
    context: Context,
    private val preferenceName: String = PREFERENCE_NAME,
    private val keyAlias: String = KEY_ALIAS,
) : BrokerInstallationStorage {
    private val preferences = context.applicationContext.getSharedPreferences(
        preferenceName,
        Context.MODE_PRIVATE,
    )

    @Synchronized
    override fun read(): BrokerInstallationRecord? {
        val encodedEnvelope = preferences.getString(RECORD_KEY, null) ?: return null
        return try {
            val envelope = JSONObject(encodedEnvelope)
            check(envelope.length() == 3 && envelope.getInt("version") == RECORD_VERSION)
            val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                GCMParameterSpec(
                    GCM_TAG_LENGTH_BITS,
                    Base64.decode(envelope.getString("iv"), Base64.NO_WRAP),
                ),
            )
            cipher.updateAAD(AUTHENTICATED_CONTEXT.toByteArray(Charsets.UTF_8))
            val plaintext = cipher.doFinal(
                Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP),
            )
            parseRecord(JSONObject(plaintext.toString(Charsets.UTF_8)))
        } catch (_: Exception) {
            recoverFromUnreadableState()
            null
        }
    }

    @Synchronized
    override fun write(record: BrokerInstallationRecord) {
        validateRecord(record)
        val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        cipher.updateAAD(AUTHENTICATED_CONTEXT.toByteArray(Charsets.UTF_8))
        val plaintext = JSONObject()
            .put("installationId", record.installationId)
            .put("installationSecret", record.installationSecret)
            .put("targetDigest", record.targetDigest)
            .put("targetCurrent", record.targetCurrent)
            .toString()
            .toByteArray(Charsets.UTF_8)
        val envelope = JSONObject()
            .put("version", RECORD_VERSION)
            .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put(
                "ciphertext",
                Base64.encodeToString(cipher.doFinal(plaintext), Base64.NO_WRAP),
            )
            .toString()
        commitPreferenceChange { putString(RECORD_KEY, envelope) }
    }

    @Synchronized
    override fun clear() {
        commitPreferenceChange { remove(RECORD_KEY) }
    }

    internal fun encryptedEnvelopeForTest(): String? {
        return preferences.getString(RECORD_KEY, null)
    }

    internal fun destroyTestState() {
        commitPreferenceChange { clear() }
        val keyStore = loadKeyStore()
        if (keyStore.containsAlias(keyAlias)) {
            keyStore.deleteEntry(keyAlias)
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = loadKeyStore()
        (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            ANDROID_KEY_STORE,
        )
        generator.init(
            KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun recoverFromUnreadableState() {
        runCatching { commitPreferenceChange { remove(RECORD_KEY) } }
        runCatching {
            val keyStore = loadKeyStore()
            if (keyStore.containsAlias(keyAlias)) {
                keyStore.deleteEntry(keyAlias)
            }
        }
    }

    private fun loadKeyStore(): KeyStore {
        return KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
    }

    @SuppressLint("ApplySharedPref", "UseKtx")
    private fun commitPreferenceChange(change: SharedPreferences.Editor.() -> Unit) {
        // A broker capability is not ready until its encrypted state is durable.
        val editor = preferences.edit()
        editor.change()
        check(editor.commit()) { "Could not persist broker installation state" }
    }

    private fun parseRecord(value: JSONObject): BrokerInstallationRecord {
        check(
            value.length() == 4 &&
                value.has("installationId") &&
                value.has("installationSecret") &&
                value.has("targetDigest") &&
                value.has("targetCurrent"),
        )
        return BrokerInstallationRecord(
            installationId = value.getString("installationId"),
            installationSecret = value.getString("installationSecret"),
            targetDigest = value.getString("targetDigest"),
            targetCurrent = value.getBoolean("targetCurrent"),
        ).also(::validateRecord)
    }

    private fun validateRecord(record: BrokerInstallationRecord) {
        require(INSTALLATION_ID_PATTERN.matches(record.installationId))
        require(INSTALLATION_SECRET_PATTERN.matches(record.installationSecret))
        require(TARGET_DIGEST_PATTERN.matches(record.targetDigest))
    }

    companion object {
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"
        private const val CIPHER_TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_LENGTH_BITS = 128
        private const val PREFERENCE_NAME = "ya_push_installation_v1"
        private const val KEY_ALIAS = "ya_push_installation_key_v1"
        private const val RECORD_KEY = "encrypted_installation"
        private const val RECORD_VERSION = 1
        private const val AUTHENTICATED_CONTEXT = "yep-anywhere-push-installation-v1"
        private val INSTALLATION_ID_PATTERN = Regex("^[A-Za-z0-9_-]{22}$")
        private val INSTALLATION_SECRET_PATTERN = Regex("^[A-Za-z0-9_-]{43}$")
        private val TARGET_DIGEST_PATTERN = Regex("^[a-f0-9]{64}$")
    }
}
