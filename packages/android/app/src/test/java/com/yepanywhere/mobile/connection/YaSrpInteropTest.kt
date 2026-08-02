package com.yepanywhere.mobile.connection

import com.nimbusds.srp6.SRP6ClientSession
import java.security.SecureRandom
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class YaSrpInteropTest {
    @Test
    fun nimbusMatchesTheProductionTypeScriptSrpProfile() {
        val fixture = loadFixture()
        val srp = fixture.getJSONObject("srp")
        val client = YaSrpClientSession(
            username = srp.getString("username"),
            password = srp.getString("password"),
            session = DeterministicClientSession(hexBytes(srp.getString("clientPrivate"))),
        )

        val proof = client.processChallenge(
            saltHex = srp.getString("salt"),
            serverPublicValueHex = srp.getString("B"),
        )

        assertEquals(2048, YaSrpClientSession.CONFIG.N.bitLength())
        assertEquals("SHA-512", YaSrpClientSession.CONFIG.H)
        assertEquals(srp.getString("N"), YaSrpClientSession.CONFIG.N.toString(16))
        assertEquals(srp.getString("g"), YaSrpClientSession.CONFIG.g.toString(16))
        assertEquals(srp.getString("A"), proof.publicValueHex)
        assertEquals(srp.getString("M1"), proof.evidenceHex)

        val rawSessionKey = client.verifyServer(srp.getString("M2"))
        assertEquals(srp.getString("rawSessionKeyHex"), rawSessionKey.toHex())
        assertEquals(
            srp.getString("baseKeyHex"),
            YaSecureTransportCrypto.deriveBaseKey(rawSessionKey).toHex(),
        )

        val fullSession = fixture.getJSONObject("fullSession")
        assertEquals(
            fullSession.getString("transportKeyHex"),
            YaSecureTransportCrypto.deriveTransportKey(
                YaSecureTransportCrypto.deriveBaseKey(rawSessionKey),
                java.util.Base64.getDecoder().decode(fullSession.getString("transportNonce")),
            ).toHex(),
        )
    }

    @Test
    fun rejectsAChangedServerProofAndCannotBeReused() {
        val srp = loadFixture().getJSONObject("srp")
        val client = YaSrpClientSession(
            username = srp.getString("username"),
            password = srp.getString("password"),
            session = DeterministicClientSession(hexBytes(srp.getString("clientPrivate"))),
        )
        client.processChallenge(srp.getString("salt"), srp.getString("B"))
        val changedProof = srp.getString("M2").replaceRange(0, 1, "0")

        assertThrows(Exception::class.java) { client.verifyServer(changedProof) }
        assertThrows(IllegalStateException::class.java) {
            client.verifyServer(srp.getString("M2"))
        }
    }

    @Test
    fun resumeCredentialDoesNotExposeItsMutableBaseKey() {
        val source = ByteArray(YaSecureTransportCrypto.KEY_BYTES) { it.toByte() }
        val credential = YaResumeCredential(
            username = "android-native-interop",
            sessionId = "session",
            baseKey = source,
            resumeProtocolVersion = YaSecureTransportCrypto.RESUME_PROTOCOL_VERSION,
        )
        source.fill(0)

        val firstCopy = credential.copyBaseKey()
        assertFalse(firstCopy.contentEquals(source))
        firstCopy.fill(0)
        assertArrayEquals(
            ByteArray(YaSecureTransportCrypto.KEY_BYTES) { it.toByte() },
            credential.copyBaseKey(),
        )
    }

    private fun loadFixture(): JSONObject {
        val stream = checkNotNull(javaClass.classLoader?.getResourceAsStream(FIXTURE_NAME))
        return stream.use { JSONObject(it.readBytes().toString(Charsets.UTF_8)) }
    }

    private class DeterministicClientSession(privateValue: ByteArray) : SRP6ClientSession() {
        init {
            random = FixedSecureRandom(privateValue)
        }
    }

    private class FixedSecureRandom(private val value: ByteArray) : SecureRandom() {
        override fun nextBytes(bytes: ByteArray) {
            bytes.fill(0)
            require(value.size <= bytes.size)
            value.copyInto(bytes, destinationOffset = bytes.size - value.size)
        }
    }

    companion object {
        private const val FIXTURE_NAME = "ya-secure-interop-v1.json"

        private fun hexBytes(value: String): ByteArray {
            require(value.length % 2 == 0)
            return ByteArray(value.length / 2) { index ->
                value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
            }
        }

        private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
    }
}
