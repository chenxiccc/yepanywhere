package com.yepanywhere.mobile.connection

import com.nimbusds.srp6.BigIntegerUtils
import com.nimbusds.srp6.SRP6ClientCredentials
import com.nimbusds.srp6.SRP6ClientSession
import com.nimbusds.srp6.SRP6CryptoParams
import java.math.BigInteger

data class YaSrpClientProof(
    val publicValueHex: String,
    val evidenceHex: String,
)

/**
 * One full YA SRP-6a login attempt.
 *
 * Nimbus implements the same non-RFC password and evidence routines used by
 * tssrp6a. The wrapper fixes YA's group/hash and removes the password-holding
 * Nimbus session as soon as the server proof has succeeded or failed.
 */
class YaSrpClientSession internal constructor(
    username: String,
    password: String,
    private var session: SRP6ClientSession?,
) {
    private var credentials: SRP6ClientCredentials? = null

    constructor(username: String, password: String) :
        this(username, password, SRP6ClientSession())

    init {
        require(username.isNotBlank())
        require(password.isNotEmpty())
        checkNotNull(session).step1(username, password)
    }

    fun processChallenge(saltHex: String, serverPublicValueHex: String): YaSrpClientProof {
        check(credentials == null) { "SRP challenge was already processed" }
        val activeSession = checkNotNull(session) { "SRP session is no longer active" }
        val result = activeSession.step2(
            CONFIG,
            parseUnsignedHex(saltHex),
            parseUnsignedHex(serverPublicValueHex),
        )
        credentials = result
        return YaSrpClientProof(
            publicValueHex = result.A.toString(16),
            evidenceHex = result.M1.toString(16),
        )
    }

    fun verifyServer(serverEvidenceHex: String): ByteArray {
        val activeSession = checkNotNull(session) { "SRP session is no longer active" }
        checkNotNull(credentials) { "SRP challenge must be processed before server proof" }
        return try {
            activeSession.step3(parseUnsignedHex(serverEvidenceHex))
            BigIntegerUtils.bigIntegerToBytes(
                checkNotNull(activeSession.sessionKey) { "SRP session key is missing" },
            )
        } finally {
            credentials = null
            session = null
        }
    }

    companion object {
        val CONFIG: SRP6CryptoParams = checkNotNull(
            SRP6CryptoParams.getInstance(2048, "SHA-512"),
        )

        private fun parseUnsignedHex(value: String): BigInteger {
            require(value.isNotEmpty() && value.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' })
            return BigInteger(value, 16)
        }
    }
}
