package com.yepanywhere.mobile.connection

import android.util.Base64
import com.goterl.lazysodium.LazySodiumAndroid
import com.goterl.lazysodium.SodiumAndroid
import com.goterl.lazysodium.interfaces.SecretBox
import java.security.MessageDigest
import java.security.SecureRandom
import org.json.JSONObject

interface YaSecretBox {
    fun seal(message: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray
    fun open(ciphertext: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray?
}

class LazySodiumSecretBox internal constructor(
    private val sodium: SecretBox.Native,
) : YaSecretBox {
    constructor() : this(LazySodiumAndroid(SodiumAndroid()))

    override fun seal(message: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray {
        requireNonceAndKey(nonce, key)
        val ciphertext = ByteArray(message.size + SecretBox.MACBYTES)
        check(
            sodium.cryptoSecretBoxEasy(
                ciphertext,
                message,
                message.size.toLong(),
                nonce,
                key,
            ),
        ) { "NaCl secretbox encryption failed" }
        return ciphertext
    }

    override fun open(ciphertext: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray? {
        requireNonceAndKey(nonce, key)
        if (ciphertext.size < SecretBox.MACBYTES) return null
        val plaintext = ByteArray(ciphertext.size - SecretBox.MACBYTES)
        return if (
            sodium.cryptoSecretBoxOpenEasy(
                plaintext,
                ciphertext,
                ciphertext.size.toLong(),
                nonce,
                key,
            )
        ) {
            plaintext
        } else {
            null
        }
    }

    private fun requireNonceAndKey(nonce: ByteArray, key: ByteArray) {
        require(nonce.size == SecretBox.NONCEBYTES) { "Secretbox nonce must be 24 bytes" }
        require(key.size == SecretBox.KEYBYTES) { "Secretbox key must be 32 bytes" }
    }
}

object YaSecureTransportCrypto {
    const val BINARY_ENVELOPE_VERSION = 1
    const val JSON_FORMAT = 1
    const val RESUME_PROTOCOL_VERSION = 3
    const val NONCE_BYTES = 24
    const val KEY_BYTES = 32

    private val transportLabel = "yep-transport-v1".toByteArray(Charsets.UTF_8)
    private val secureRandom = SecureRandom()

    fun deriveBaseKey(rawSrpSessionKey: ByteArray): ByteArray {
        require(rawSrpSessionKey.isNotEmpty())
        return sha512(rawSrpSessionKey).copyOf(KEY_BYTES)
    }

    fun deriveTransportKey(baseKey: ByteArray, transportNonce: ByteArray): ByteArray {
        require(baseKey.size == KEY_BYTES)
        require(transportNonce.size == NONCE_BYTES)
        return sha512(transportLabel + baseKey + transportNonce).copyOf(KEY_BYTES)
    }

    fun decodeBase64(value: String): ByteArray = Base64.decode(value, Base64.NO_WRAP)

    fun encodeBase64(value: ByteArray): String = Base64.encodeToString(value, Base64.NO_WRAP)

    fun decryptJsonEnvelope(envelope: String, key: ByteArray, secretBox: YaSecretBox): String? {
        val parsed = runCatching { JSONObject(envelope) }.getOrNull() ?: return null
        if (parsed.length() != 2 || !parsed.has("nonce") || !parsed.has("ciphertext")) {
            return null
        }
        val nonce = runCatching { decodeBase64(parsed.getString("nonce")) }.getOrNull()
            ?: return null
        val ciphertext = runCatching { decodeBase64(parsed.getString("ciphertext")) }.getOrNull()
            ?: return null
        return secretBox.open(ciphertext, nonce, key)?.toString(Charsets.UTF_8)
    }

    fun encryptJsonEnvelope(
        plaintext: String,
        key: ByteArray,
        secretBox: YaSecretBox,
        nonce: ByteArray = randomNonce(),
    ): String {
        val ciphertext = secretBox.seal(plaintext.toByteArray(Charsets.UTF_8), nonce, key)
        return JSONObject()
            .put("nonce", encodeBase64(nonce))
            .put("ciphertext", encodeBase64(ciphertext))
            .toString()
    }

    fun encryptBinaryJson(
        plaintext: String,
        key: ByteArray,
        secretBox: YaSecretBox,
        nonce: ByteArray = randomNonce(),
    ): ByteArray {
        val payload = plaintext.toByteArray(Charsets.UTF_8)
        val inner = ByteArray(1 + payload.size)
        inner[0] = JSON_FORMAT.toByte()
        payload.copyInto(inner, 1)
        val ciphertext = secretBox.seal(inner, nonce, key)
        return byteArrayOf(BINARY_ENVELOPE_VERSION.toByte()) + nonce + ciphertext
    }

    fun decryptBinaryJson(
        envelope: ByteArray,
        key: ByteArray,
        secretBox: YaSecretBox,
    ): String? {
        if (envelope.size < 1 + NONCE_BYTES + SecretBox.MACBYTES + 1) return null
        if (envelope[0].toInt() != BINARY_ENVELOPE_VERSION) return null
        val nonce = envelope.copyOfRange(1, 1 + NONCE_BYTES)
        val ciphertext = envelope.copyOfRange(1 + NONCE_BYTES, envelope.size)
        val inner = secretBox.open(ciphertext, nonce, key) ?: return null
        if (inner.isEmpty() || inner[0].toInt() != JSON_FORMAT) return null
        return inner.copyOfRange(1, inner.size).toString(Charsets.UTF_8)
    }

    fun randomNonce(): ByteArray = ByteArray(NONCE_BYTES).also(secureRandom::nextBytes)

    private fun sha512(value: ByteArray): ByteArray {
        return MessageDigest.getInstance("SHA-512").digest(value)
    }
}
