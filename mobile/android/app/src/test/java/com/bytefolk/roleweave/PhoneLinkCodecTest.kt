package com.bytefolk.roleweave

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneLinkCodecTest {
    @Test
    fun parseSnapshotReadsRolesWithoutHostPaths() {
        val snapshot = PhoneLinkCodec.parseSnapshot(
            """
            {
              "name": "oss-maintainer",
              "description": "开源维护组织",
              "roles": [
                {"id": "repo-owner", "name": "仓库负责人", "description": "路线图", "skillExcerpt": "只读"}
              ]
            }
            """.trimIndent()
        )
        assertEquals("oss-maintainer", snapshot.name)
        assertEquals("repo-owner", snapshot.roles.single().id)
        assertFalse(snapshot.roles.single().skillExcerpt.contains("/workspace"))
    }

    @Test
    fun helloPayloadNeverEmbedsCommandText() {
        val hello = PhoneLinkCodec.helloPayload("abc")
        assertTrue(hello.contains("phone.hello"))
        assertTrue(hello.contains("abc"))
        assertFalse(hello.contains("command.submit"))
    }

    @Test
    fun commandPayloadRequiresExplicitPosition() {
        val withRole = PhoneLinkCodec.commandPayload("cmd-1", "看一下 PR", "issue-researcher")
        assertTrue(withRole.contains("issue-researcher"))
        val withoutRole = PhoneLinkCodec.commandPayload("cmd-1", "看一下 PR", null)
        assertFalse(withoutRole.contains("positionId"))
    }

    @Test
    fun reconnectDelayIsExponential() {
        assertEquals(1000L, PhoneLinkCodec.reconnectDelayMs(1))
        assertEquals(2000L, PhoneLinkCodec.reconnectDelayMs(2))
        assertEquals(4000L, PhoneLinkCodec.reconnectDelayMs(3))
        assertEquals(8000L, PhoneLinkCodec.reconnectDelayMs(4))
        assertEquals(16000L, PhoneLinkCodec.reconnectDelayMs(5))
    }

    @Test
    fun commandStatusLabelsAreStable() {
        assertEquals("电脑已接到", PhoneLinkCodec.commandStatusLabel("accepted"))
        assertEquals("请在电脑上确认", PhoneLinkCodec.commandStatusLabel("needs_approval"))
        assertEquals("unknown", PhoneLinkCodec.commandStatusLabel("unknown"))
    }
}
