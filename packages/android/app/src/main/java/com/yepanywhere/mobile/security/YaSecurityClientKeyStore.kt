package com.yepanywhere.mobile.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec

interface YaSecurityClientKeyStore {
    fun ensureKey(alias: String)
    fun publicKeySpki(alias: String): ByteArray
    fun sign(alias: String, message: ByteArray): ByteArray
    fun delete(alias: String)
}

class AndroidKeystoreSecurityClientKeyStore : YaSecurityClientKeyStore {
    override fun ensureKey(alias: String) {
        requireValidAlias(alias)
        if (keyStore().containsAlias(alias)) return
        val generator = KeyPairGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_EC,
            ANDROID_KEY_STORE,
        )
        generator.initialize(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build(),
        )
        generator.generateKeyPair()
    }

    override fun publicKeySpki(alias: String): ByteArray {
        requireValidAlias(alias)
        return checkNotNull(keyStore().getCertificate(alias)) {
            "Security-client key is missing"
        }.publicKey.encoded.copyOf()
    }

    override fun sign(alias: String, message: ByteArray): ByteArray {
        requireValidAlias(alias)
        val privateKey = checkNotNull(keyStore().getKey(alias, null)) {
            "Security-client key is missing"
        }
        return Signature.getInstance(SIGNATURE_ALGORITHM).run {
            initSign(privateKey as java.security.PrivateKey)
            update(message)
            sign()
        }
    }

    override fun delete(alias: String) {
        requireValidAlias(alias)
        keyStore().deleteEntry(alias)
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply {
        load(null)
    }

    private fun requireValidAlias(alias: String) {
        require(ALIAS_PATTERN.matches(alias)) { "Invalid security-client key alias" }
    }

    companion object {
        const val SIGNATURE_ALGORITHM = "SHA256withECDSA"
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"
        private val ALIAS_PATTERN = Regex("^[A-Za-z0-9._-]{1,160}$")
    }
}
