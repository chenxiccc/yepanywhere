package com.yepanywhere.mobile.ui

import com.yepanywhere.mobile.profiles.YaServerRouteKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class YaPairingInputTest {
    @Test
    fun defaultsToThePublicRelayUsingTheNormalizedUsernameAsTarget() {
        val input = YaPairingInput(
            username = "  My-Server  ",
            password = "password",
        )

        val username = input.normalizedUsername()
        val route = input.resolveRoute(username)

        assertEquals(YaPairingRouteKind.RELAY, input.routeKind)
        assertEquals("my-server", username)
        assertEquals(YaServerRouteKind.RELAY, route.kind)
        assertEquals(DEFAULT_RELAY_WEBSOCKET_URL, route.websocketUrl)
        assertEquals("my-server", route.relayTarget)
    }

    @Test
    fun advancedRelayUsesTheExplicitUrlWithoutChangingItsTarget() {
        val input = YaPairingInput(
            username = "my-server",
            password = "password",
            relayWebsocketUrl = "  wss://relay.example.test/ws  ",
        )

        val route = input.resolveRoute(input.normalizedUsername())

        assertEquals("wss://relay.example.test/ws", route.websocketUrl)
        assertEquals("my-server", route.relayTarget)
    }

    @Test
    fun advancedDirectUsesItsOwnUrlAndPreservesTheSrpUsername() {
        val input = YaPairingInput(
            username = "Case-Sensitive-User",
            password = "password",
            routeKind = YaPairingRouteKind.DIRECT,
            relayWebsocketUrl = "wss://ignored-relay.example.test/ws",
            directWebsocketUrl = "  wss://server.example.test/api/ws  ",
        )

        val username = input.normalizedUsername()
        val route = input.resolveRoute(username)

        assertEquals("Case-Sensitive-User", username)
        assertEquals(YaServerRouteKind.DIRECT, route.kind)
        assertEquals("wss://server.example.test/api/ws", route.websocketUrl)
        assertNull(route.relayTarget)
    }
}
