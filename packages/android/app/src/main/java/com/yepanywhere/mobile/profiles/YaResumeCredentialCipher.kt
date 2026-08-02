package com.yepanywhere.mobile.profiles

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

internal interface YaResumeCredentialCipher {
    fun encrypt(profileId: String, plaintext: ByteArray): String
    fun decrypt(profileId: String, envelope: String): ByteArray?
}

internal class AndroidKeystoreResumeCredentialCipher(
    private val keyAlias: String = KEY_ALIAS,
) : YaResumeCredentialCipher {
    @Synchronized
    override fun encrypt(profileId: String, plaintext: ByteArray): String {
        requireUuid(profileId, "profile id")
        val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        cipher.updateAAD(authenticatedContext(profileId))
        return JSONObject()
            .put("version", ENVELOPE_VERSION)
            .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put(
                "ciphertext",
                Base64.encodeToString(cipher.doFinal(plaintext), Base64.NO_WRAP),
            )
            .toString()
    }

    @Synchronized
    override fun decrypt(profileId: String, envelope: String): ByteArray? {
        requireUuid(profileId, "profile id")
        return runCatching {
            val parsed = JSONObject(envelope)
            check(
                parsed.length() == 3 &&
                    parsed.getInt("version") == ENVELOPE_VERSION &&
                    parsed.has("iv") &&
                    parsed.has("ciphertext"),
            )
            val iv = Base64.decode(parsed.getString("iv"), Base64.NO_WRAP)
            check(iv.size == GCM_IV_BYTES)
            val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv),
            )
            cipher.updateAAD(authenticatedContext(profileId))
            cipher.doFinal(Base64.decode(parsed.getString("ciphertext"), Base64.NO_WRAP))
        }.getOrNull()
    }

    internal fun destroyTestKey() {
        val keyStore = loadKeyStore()
        if (keyStore.containsAlias(keyAlias)) {
            keyStore.deleteEntry(keyAlias)
        }
    }

    private fun authenticatedContext(profileId: String): ByteArray {
        return "$AUTHENTICATED_CONTEXT:$profileId".toByteArray(Charsets.UTF_8)
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

    private fun loadKeyStore(): KeyStore {
        return KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
    }

    companion object {
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"
        private const val CIPHER_TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_LENGTH_BITS = 128
        private const val GCM_IV_BYTES = 12
        private const val ENVELOPE_VERSION = 1
        private const val AUTHENTICATED_CONTEXT = "yep-anywhere-resume-credential-v1"
        private const val KEY_ALIAS = "ya_paired_server_resume_key_v1"
    }
}
