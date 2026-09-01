// Captured 2026-08-14 from a REAL `opencode serve` 1.18.18 run (SA.0 probe):
// a scripted parent turn calls the `task` tool (subagent_type "general"),
// the child session runs a permission-gated bash, the ask is answered, the
// child finishes, and the parent completes. Raw global /event payloads in
// arrival order, filtered to the session-relevant types (server.connected,
// plugin.added, catalog/reference/integration.updated, session.diff and
// session.updated noise dropped; ids and casing untouched).
//
// Load-bearing truths this sequence pins (see PLAN.md Phase SA, SA.0):
//  - parent `task` tool part (pending) precedes child session.created
//  - the join key parent->child is task part state.metadata.sessionId
//    (lowercase d) alongside parentSessionId; Session.parentID on the child
//  - child text/tool/step parts + token-grain message.part.delta ride the
//    SAME global stream, tagged with the child sessionID
//  - the child permission.asked carries the CHILD sessionID; the deprecated
//    per-session reply endpoint accepted a reply addressed with the ROOT
//    session id (no ownership validation, engine 1.18.18)
//  - child session.idle fires BEFORE the parent task part completes and
//    long before parent session.idle

/** The captured sequence, in arrival order. */
export const OPENCODE_SUBAGENT_EVENTS: {
  type: string;
  properties: Record<string, unknown>;
  /** Some 1.18.18 envelopes also carry a top-level event id — kept verbatim. */
  id?: string;
}[] = [
  {
    "id": "evt_0003b95e7001TYpHgjMC1DZsAC",
    "type": "session.created",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "info": {
        "id": "ses_sa0probe00000000000root",
        "slug": "playful-pixel",
        "version": "1.18.18",
        "projectID": "global",
        "directory": "/tmp/sa0-work-5KEWn0",
        "path": "tmp/sa0-work-5KEWn0",
        "title": "New session - 2026-08-14T12:25:00.134Z",
        "cost": 0,
        "tokens": {
          "input": 0,
          "output": 0,
          "reasoning": 0,
          "cache": {
            "read": 0,
            "write": 0
          }
        },
        "time": {
          "created": 1786710300134,
          "updated": 1786710300134
        }
      }
    }
  },
  {
    "id": "evt_0003b966d001MwzEhz5B9p47DH",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "info": {
        "id": "msg_0003b965b001gSbeLPM7axRjo6",
        "role": "user",
        "sessionID": "ses_sa0probe00000000000root",
        "time": {
          "created": 1786710300251
        },
        "agent": "build",
        "model": {
          "providerID": "fake",
          "modelID": "fake-model"
        }
      }
    }
  },
  {
    "id": "evt_0003b998a001v5UIim8ukfGBeu",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "part": {
        "type": "text",
        "text": "spawn the probe subagent",
        "messageID": "msg_0003b965b001gSbeLPM7axRjo6",
        "sessionID": "ses_sa0probe00000000000root",
        "id": "prt_0003b966b001rBPTE4NQUTRSul"
      },
      "time": 1786710301065
    }
  },
  {
    "id": "evt_0003b999d001zQnubnMmjOkHsM",
    "type": "session.status",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "status": {
        "type": "busy"
      }
    }
  },
  {
    "id": "evt_0003b99a40019z3KqkeMbT0Oer",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "info": {
        "id": "msg_0003b99a4001HqWhWR7p8R1Qb3",
        "parentID": "msg_0003b965b001gSbeLPM7axRjo6",
        "role": "assistant",
        "mode": "build",
        "agent": "build",
        "path": {
          "cwd": "/tmp/sa0-work-5KEWn0",
          "root": "/"
        },
        "cost": 0,
        "tokens": {
          "input": 0,
          "output": 0,
          "reasoning": 0,
          "cache": {
            "read": 0,
            "write": 0
          }
        },
        "modelID": "fake-model",
        "providerID": "fake",
        "time": {
          "created": 1786710301092
        },
        "sessionID": "ses_sa0probe00000000000root"
      }
    }
  },
  {
    "id": "evt_0003b99f5001GaoFqn0MeJtAaI",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "info": {
        "role": "user",
        "time": {
          "created": 1786710300251
        },
        "agent": "build",
        "model": {
          "providerID": "fake",
          "modelID": "fake-model"
        },
        "id": "msg_0003b965b001gSbeLPM7axRjo6",
        "sessionID": "ses_sa0probe00000000000root",
        "summary": {
          "diffs": []
        }
      }
    }
  },
  {
    "id": "evt_0003b9ccd0018q2wp88hA5sX6D",
    "type": "session.status",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "status": {
        "type": "busy"
      }
    }
  },
  {
    "id": "evt_0003b9ce4001Rd5FiFj3HWaWLO",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "part": {
        "id": "prt_0003b9ce4001qpqZfIB6n6fzxn",
        "messageID": "msg_0003b99a4001HqWhWR7p8R1Qb3",
        "sessionID": "ses_sa0probe00000000000root",
        "type": "step-start"
      },
      "time": 1786710301924
    }
  },
  {
    "id": "evt_0003b9cea001Jh6cF0gfruzOou",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "part": {
        "id": "prt_0003b9ce9001BFkcKfmqQBXEkW",
        "messageID": "msg_0003b99a4001HqWhWR7p8R1Qb3",
        "sessionID": "ses_sa0probe00000000000root",
        "type": "tool",
        "tool": "task",
        "callID": "call_2",
        "state": {
          "status": "pending",
          "input": {},
          "raw": ""
        }
      },
      "time": 1786710301930
    }
  },
  {
    "id": "evt_0003b9cff0010aIngXr2ItTvAR",
    "type": "session.created",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "info": {
        "id": "ses_sa0probe0000000000child",
        "slug": "eager-sailor",
        "version": "1.18.18",
        "projectID": "global",
        "directory": "/tmp/sa0-work-5KEWn0",
        "path": "tmp/sa0-work-5KEWn0",
        "parentID": "ses_sa0probe00000000000root",
        "title": "sa0 probe child (@general subagent)",
        "agent": "general",
        "permission": [
          {
            "permission": "task",
            "pattern": "*",
            "action": "deny"
          }
        ],
        "cost": 0,
        "tokens": {
          "input": 0,
          "output": 0,
          "reasoning": 0,
          "cache": {
            "read": 0,
            "write": 0
          }
        },
        "time": {
          "created": 1786710301950,
          "updated": 1786710301950
        }
      }
    }
  },
  {
    "id": "evt_0003b9d09001cTT1IUD6oA7alW",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "part": {
        "type": "tool",
        "tool": "task",
        "callID": "call_2",
        "state": {
          "title": "sa0 probe child",
          "metadata": {
            "parentSessionId": "ses_sa0probe00000000000root",
            "sessionId": "ses_sa0probe0000000000child",
            "model": {
              "modelID": "fake-model",
              "providerID": "fake"
            }
          },
          "status": "running",
          "input": {
            "description": "sa0 probe child",
            "prompt": "CHILD_TASK: run the probe command exactly once.",
            "subagent_type": "general"
          },
          "time": {
            "start": 1786710301961
          }
        },
        "id": "prt_0003b9ce9001BFkcKfmqQBXEkW",
        "sessionID": "ses_sa0probe00000000000root",
        "messageID": "msg_0003b99a4001HqWhWR7p8R1Qb3"
      },
      "time": 1786710301961
    }
  },
  {
    "id": "evt_0003b9d1c001YRBL2A5m96Jo8t",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "info": {
        "id": "msg_0003b9d12001sv3mzRwub3W4ZM",
        "role": "user",
        "sessionID": "ses_sa0probe0000000000child",
        "time": {
          "created": 1786710301973
        },
        "agent": "general",
        "model": {
          "providerID": "fake",
          "modelID": "fake-model"
        }
      }
    }
  },
  {
    "id": "evt_0003b9d1f0011L8StOutGnKjW4",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "part": {
        "type": "text",
        "text": "CHILD_TASK: run the probe command exactly once.",
        "messageID": "msg_0003b9d12001sv3mzRwub3W4ZM",
        "sessionID": "ses_sa0probe0000000000child",
        "id": "prt_0003b9d1b001i2PluJW6H9h1tX"
      },
      "time": 1786710301983
    }
  },
  {
    "id": "evt_0003b9d33001ufKGlzK7wN8r8R",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "part": {
        "type": "tool",
        "tool": "task",
        "callID": "call_2",
        "state": {
          "title": "sa0 probe child",
          "metadata": {
            "parentSessionId": "ses_sa0probe00000000000root",
            "sessionId": "ses_sa0probe0000000000child",
            "model": {
              "modelID": "fake-model",
              "providerID": "fake"
            }
          },
          "status": "running",
          "input": {
            "description": "sa0 probe child",
            "prompt": "CHILD_TASK: run the probe command exactly once.",
            "subagent_type": "general"
          },
          "time": {
            "start": 1786710301961
          }
        },
        "id": "prt_0003b9ce9001BFkcKfmqQBXEkW",
        "sessionID": "ses_sa0probe00000000000root",
        "messageID": "msg_0003b99a4001HqWhWR7p8R1Qb3"
      },
      "time": 1786710302003
    }
  },
  {
    "id": "evt_0003b9d3b0011mPgxdyd7iQpRW",
    "type": "session.status",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "status": {
        "type": "busy"
      }
    }
  },
  {
    "id": "evt_0003b9d3d001ym1OtcI2ZtKPgB",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "info": {
        "id": "msg_0003b9d3d001xb51TiRjXmV80H",
        "parentID": "msg_0003b9d12001sv3mzRwub3W4ZM",
        "role": "assistant",
        "mode": "general",
        "agent": "general",
        "path": {
          "cwd": "/tmp/sa0-work-5KEWn0",
          "root": "/"
        },
        "cost": 0,
        "tokens": {
          "input": 0,
          "output": 0,
          "reasoning": 0,
          "cache": {
            "read": 0,
            "write": 0
          }
        },
        "modelID": "fake-model",
        "providerID": "fake",
        "time": {
          "created": 1786710302013
        },
        "sessionID": "ses_sa0probe0000000000child"
      }
    }
  },
  {
    "id": "evt_0003b9e5c001BUcy05UVk7cSdQ",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "info": {
        "role": "user",
        "time": {
          "created": 1786710301973
        },
        "agent": "general",
        "model": {
          "providerID": "fake",
          "modelID": "fake-model"
        },
        "id": "msg_0003b9d12001sv3mzRwub3W4ZM",
        "sessionID": "ses_sa0probe0000000000child",
        "summary": {
          "diffs": []
        }
      }
    }
  },
  {
    "id": "evt_0003b9e800012xgZfFF5fGm6r3",
    "type": "session.status",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "status": {
        "type": "busy"
      }
    }
  },
  {
    "id": "evt_0003b9e9d0013WGYaMcorUy5vQ",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "part": {
        "id": "prt_0003b9e9d001TVFXq515YfLN4Z",
        "messageID": "msg_0003b9d3d001xb51TiRjXmV80H",
        "sessionID": "ses_sa0probe0000000000child",
        "type": "step-start"
      },
      "time": 1786710302365
    }
  },
  {
    "id": "evt_0003b9ea1001j2jA0ORSF77je7",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "part": {
        "id": "prt_0003b9ea1001128sL6LhvFFbhs",
        "messageID": "msg_0003b9d3d001xb51TiRjXmV80H",
        "sessionID": "ses_sa0probe0000000000child",
        "type": "tool",
        "tool": "bash",
        "callID": "call_3",
        "state": {
          "status": "pending",
          "input": {},
          "raw": ""
        }
      },
      "time": 1786710302369
    }
  },
  {
    "id": "evt_0003b9eb0001nDBpk7v0WnmWEl",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "part": {
        "type": "tool",
        "tool": "bash",
        "callID": "call_3",
        "state": {
          "status": "running",
          "input": {
            "command": "echo child-probe",
            "description": "sa0 child probe"
          },
          "time": {
            "start": 1786710302384
          }
        },
        "id": "prt_0003b9ea1001128sL6LhvFFbhs",
        "sessionID": "ses_sa0probe0000000000child",
        "messageID": "msg_0003b9d3d001xb51TiRjXmV80H"
      },
      "time": 1786710302384
    }
  },
  {
    "id": "evt_0003b9f65002552q9ciSnlX3xK",
    "type": "permission.asked",
    "properties": {
      "id": "per_0003b9f65001yQ0rDdeN7HiAmE",
      "sessionID": "ses_sa0probe0000000000child",
      "permission": "bash",
      "patterns": [
        "echo child-probe"
      ],
      "metadata": {
        "command": "echo child-probe"
      },
      "always": [
        "echo *"
      ],
      "tool": {
        "messageID": "msg_0003b9d3d001xb51TiRjXmV80H",
        "callID": "call_3"
      }
    }
  },
  {
    "id": "evt_0003b9fbf001gXj1p7bUWWeplj",
    "type": "permission.replied",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "requestID": "per_0003b9f65001yQ0rDdeN7HiAmE",
      "reply": "once"
    }
  },
  {
    "id": "evt_0003b9fc90014fbQDu50KSlzK8",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "part": {
        "type": "tool",
        "tool": "bash",
        "callID": "call_3",
        "state": {
          "metadata": {
            "output": ""
          },
          "status": "running",
          "input": {
            "command": "echo child-probe",
            "description": "sa0 child probe"
          },
          "time": {
            "start": 1786710302664
          }
        },
        "id": "prt_0003b9ea1001128sL6LhvFFbhs",
        "sessionID": "ses_sa0probe0000000000child",
        "messageID": "msg_0003b9d3d001xb51TiRjXmV80H"
      },
      "time": 1786710302664
    }
  },
  {
    "id": "evt_0003ba015001iidPjC0l50hDLS",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "part": {
        "type": "tool",
        "tool": "bash",
        "callID": "call_3",
        "state": {
          "metadata": {
            "output": "child-probe\n"
          },
          "status": "running",
          "input": {
            "command": "echo child-probe",
            "description": "sa0 child probe"
          },
          "time": {
            "start": 1786710302740
          }
        },
        "id": "prt_0003b9ea1001128sL6LhvFFbhs",
        "sessionID": "ses_sa0probe0000000000child",
        "messageID": "msg_0003b9d3d001xb51TiRjXmV80H"
      },
      "time": 1786710302740
    }
  },
  {
    "id": "evt_0003ba0290011z5e8hUKiFdhUL",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "part": {
        "type": "tool",
        "tool": "bash",
        "callID": "call_3",
        "state": {
          "status": "completed",
          "input": {
            "command": "echo child-probe",
            "description": "sa0 child probe"
          },
          "output": "child-probe\n",
          "metadata": {
            "output": "child-probe\n",
            "exit": 0,
            "truncated": false
          },
          "title": "echo child-probe",
          "time": {
            "start": 1786710302740,
            "end": 1786710302761
          }
        },
        "id": "prt_0003b9ea1001128sL6LhvFFbhs",
        "sessionID": "ses_sa0probe0000000000child",
        "messageID": "msg_0003b9d3d001xb51TiRjXmV80H"
      },
      "time": 1786710302761
    }
  },
  {
    "id": "evt_0003ba033001vLnpuxLognpKZw",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "part": {
        "id": "prt_0003ba032001vPGZns7HV0JuiW",
        "reason": "tool-calls",
        "messageID": "msg_0003b9d3d001xb51TiRjXmV80H",
        "sessionID": "ses_sa0probe0000000000child",
        "type": "step-finish",
        "tokens": {
          "input": 0,
          "output": 0,
          "reasoning": 0,
          "cache": {
            "write": 0,
            "read": 0
          }
        },
        "cost": 0
      },
      "time": 1786710302771
    }
  },
  {
    "id": "evt_0003ba038001GXnMlHDFC7rINY",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "info": {
        "id": "msg_0003b9d3d001xb51TiRjXmV80H",
        "parentID": "msg_0003b9d12001sv3mzRwub3W4ZM",
        "role": "assistant",
        "mode": "general",
        "agent": "general",
        "path": {
          "cwd": "/tmp/sa0-work-5KEWn0",
          "root": "/"
        },
        "cost": 0,
        "tokens": {
          "input": 0,
          "output": 0,
          "reasoning": 0,
          "cache": {
            "write": 0,
            "read": 0
          }
        },
        "modelID": "fake-model",
        "providerID": "fake",
        "time": {
          "created": 1786710302013,
          "completed": 1786710302782
        },
        "sessionID": "ses_sa0probe0000000000child",
        "finish": "tool-calls"
      }
    }
  },
  {
    "id": "evt_0003ba03f001ih63DvgWgxtgXm",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "info": {
        "id": "msg_0003b9d3d001xb51TiRjXmV80H",
        "parentID": "msg_0003b9d12001sv3mzRwub3W4ZM",
        "role": "assistant",
        "mode": "general",
        "agent": "general",
        "path": {
          "cwd": "/tmp/sa0-work-5KEWn0",
          "root": "/"
        },
        "cost": 0,
        "tokens": {
          "input": 0,
          "output": 0,
          "reasoning": 0,
          "cache": {
            "write": 0,
            "read": 0
          }
        },
        "modelID": "fake-model",
        "providerID": "fake",
        "time": {
          "created": 1786710302013,
          "completed": 1786710302782
        },
        "sessionID": "ses_sa0probe0000000000child",
        "finish": "tool-calls"
      }
    }
  },
  {
    "id": "evt_0003ba042001IEMP1Y0WWgrfST",
    "type": "session.status",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "status": {
        "type": "busy"
      }
    }
  },
  {
    "id": "evt_0003ba045001I3G6Vr6vKjaNj0",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "info": {
        "id": "msg_0003ba045001y2RoS2m46oH2A6",
        "parentID": "msg_0003b9d12001sv3mzRwub3W4ZM",
        "role": "assistant",
        "mode": "general",
        "agent": "general",
        "path": {
          "cwd": "/tmp/sa0-work-5KEWn0",
          "root": "/"
        },
        "cost": 0,
        "tokens": {
          "input": 0,
          "output": 0,
          "reasoning": 0,
          "cache": {
            "read": 0,
            "write": 0
          }
        },
        "modelID": "fake-model",
        "providerID": "fake",
        "time": {
          "created": 1786710302789
        },
        "sessionID": "ses_sa0probe0000000000child"
      }
    }
  },
  {
    "id": "evt_0003ba06c0018uBERPtHhDJLSQ",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "info": {
        "role": "user",
        "time": {
          "created": 1786710301973
        },
        "agent": "general",
        "model": {
          "providerID": "fake",
          "modelID": "fake-model"
        },
        "summary": {
          "diffs": []
        },
        "id": "msg_0003b9d12001sv3mzRwub3W4ZM",
        "sessionID": "ses_sa0probe0000000000child"
      }
    }
  },
  {
    "id": "evt_0003ba09c001zyklDye28t6gHr",
    "type": "session.status",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "status": {
        "type": "busy"
      }
    }
  },
  {
    "id": "evt_0003ba0c3001KwTDWMfi07oe5L",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "part": {
        "id": "prt_0003ba0c3001pgmk772bQyRFG5",
        "messageID": "msg_0003ba045001y2RoS2m46oH2A6",
        "sessionID": "ses_sa0probe0000000000child",
        "type": "step-start"
      },
      "time": 1786710302915
    }
  },
  {
    "id": "evt_0003ba0c90011OCPgbjM49X7jG",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "part": {
        "id": "prt_0003ba0c90010o20gyZ7Cv49od",
        "messageID": "msg_0003ba045001y2RoS2m46oH2A6",
        "sessionID": "ses_sa0probe0000000000child",
        "type": "text",
        "text": "",
        "time": {
          "start": 1786710302921
        }
      },
      "time": 1786710302921
    }
  },
  {
    "id": "evt_0003ba0cd001SnYmcGRGP1rQps",
    "type": "message.part.delta",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "messageID": "msg_0003ba045001y2RoS2m46oH2A6",
      "partID": "prt_0003ba0c90010o20gyZ7Cv49od",
      "field": "text",
      "delta": "CHILD DONE \u2014 the token never left the daemon."
    }
  },
  {
    "id": "evt_0003ba0ce001a6AvXeg4UeL0tz",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "part": {
        "id": "prt_0003ba0c90010o20gyZ7Cv49od",
        "messageID": "msg_0003ba045001y2RoS2m46oH2A6",
        "sessionID": "ses_sa0probe0000000000child",
        "type": "text",
        "text": "CHILD DONE \u2014 the token never left the daemon.",
        "time": {
          "start": 1786710302921,
          "end": 1786710302926
        }
      },
      "time": 1786710302926
    }
  },
  {
    "id": "evt_0003ba0d4001WU0MIGvnj0g713",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "part": {
        "id": "prt_0003ba0d4001KObePtlXgbrnQW",
        "reason": "stop",
        "messageID": "msg_0003ba045001y2RoS2m46oH2A6",
        "sessionID": "ses_sa0probe0000000000child",
        "type": "step-finish",
        "tokens": {
          "total": 14,
          "input": 10,
          "output": 4,
          "reasoning": 0,
          "cache": {
            "write": 0,
            "read": 0
          }
        },
        "cost": 0
      },
      "time": 1786710302932
    }
  },
  {
    "id": "evt_0003ba0d8001dBCxD9g6V1cKLs",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "info": {
        "id": "msg_0003ba045001y2RoS2m46oH2A6",
        "parentID": "msg_0003b9d12001sv3mzRwub3W4ZM",
        "role": "assistant",
        "mode": "general",
        "agent": "general",
        "path": {
          "cwd": "/tmp/sa0-work-5KEWn0",
          "root": "/"
        },
        "cost": 0,
        "tokens": {
          "total": 14,
          "input": 10,
          "output": 4,
          "reasoning": 0,
          "cache": {
            "write": 0,
            "read": 0
          }
        },
        "modelID": "fake-model",
        "providerID": "fake",
        "time": {
          "created": 1786710302789,
          "completed": 1786710302941
        },
        "sessionID": "ses_sa0probe0000000000child",
        "finish": "stop"
      }
    }
  },
  {
    "id": "evt_0003ba0dd001IMXdC3y7CBpKui",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "info": {
        "id": "msg_0003ba045001y2RoS2m46oH2A6",
        "parentID": "msg_0003b9d12001sv3mzRwub3W4ZM",
        "role": "assistant",
        "mode": "general",
        "agent": "general",
        "path": {
          "cwd": "/tmp/sa0-work-5KEWn0",
          "root": "/"
        },
        "cost": 0,
        "tokens": {
          "total": 14,
          "input": 10,
          "output": 4,
          "reasoning": 0,
          "cache": {
            "write": 0,
            "read": 0
          }
        },
        "modelID": "fake-model",
        "providerID": "fake",
        "time": {
          "created": 1786710302789,
          "completed": 1786710302941
        },
        "sessionID": "ses_sa0probe0000000000child",
        "finish": "stop"
      }
    }
  },
  {
    "id": "evt_0003ba0e0001UP0i7J0LB9vWVv",
    "type": "session.status",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "status": {
        "type": "busy"
      }
    }
  },
  {
    "id": "evt_0003ba0e7001tA7VU2f6MBUiUB",
    "type": "session.status",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "status": {
        "type": "idle"
      }
    }
  },
  {
    "id": "evt_0003ba0e7002NHqW8oR7Rsalc3",
    "type": "session.idle",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child"
    }
  },
  {
    "id": "evt_0003ba0ee0011RXwaHhR9Mi5hh",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "part": {
        "type": "tool",
        "tool": "task",
        "callID": "call_2",
        "state": {
          "status": "completed",
          "input": {
            "description": "sa0 probe child",
            "prompt": "CHILD_TASK: run the probe command exactly once.",
            "subagent_type": "general"
          },
          "output": "<task id=\"CHILD\" state=\"completed\">\n<task_result>\nCHILD DONE \u2014 the token never left the daemon.\n</task_result>\n</task>",
          "metadata": {
            "parentSessionId": "ses_sa0probe00000000000root",
            "sessionId": "ses_sa0probe0000000000child",
            "model": {
              "modelID": "fake-model",
              "providerID": "fake"
            },
            "truncated": false
          },
          "title": "sa0 probe child",
          "time": {
            "start": 1786710301961,
            "end": 1786710302958
          }
        },
        "id": "prt_0003b9ce9001BFkcKfmqQBXEkW",
        "sessionID": "ses_sa0probe00000000000root",
        "messageID": "msg_0003b99a4001HqWhWR7p8R1Qb3"
      },
      "time": 1786710302958
    }
  },
  {
    "id": "evt_0003ba0f3001lfB6gxTxuxIfKa",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "part": {
        "id": "prt_0003ba0f3001QfUqkc0VX01xMu",
        "reason": "tool-calls",
        "messageID": "msg_0003b99a4001HqWhWR7p8R1Qb3",
        "sessionID": "ses_sa0probe00000000000root",
        "type": "step-finish",
        "tokens": {
          "input": 0,
          "output": 0,
          "reasoning": 0,
          "cache": {
            "write": 0,
            "read": 0
          }
        },
        "cost": 0
      },
      "time": 1786710302963
    }
  },
  {
    "id": "evt_0003ba0f70019KTx59Av5IEL2K",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "info": {
        "id": "msg_0003b99a4001HqWhWR7p8R1Qb3",
        "parentID": "msg_0003b965b001gSbeLPM7axRjo6",
        "role": "assistant",
        "mode": "build",
        "agent": "build",
        "path": {
          "cwd": "/tmp/sa0-work-5KEWn0",
          "root": "/"
        },
        "cost": 0,
        "tokens": {
          "input": 0,
          "output": 0,
          "reasoning": 0,
          "cache": {
            "write": 0,
            "read": 0
          }
        },
        "modelID": "fake-model",
        "providerID": "fake",
        "time": {
          "created": 1786710301092,
          "completed": 1786710302971
        },
        "sessionID": "ses_sa0probe00000000000root",
        "finish": "tool-calls"
      }
    }
  },
  {
    "id": "evt_0003ba0fb001ThZ2r9PhvnJsNG",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "info": {
        "id": "msg_0003b99a4001HqWhWR7p8R1Qb3",
        "parentID": "msg_0003b965b001gSbeLPM7axRjo6",
        "role": "assistant",
        "mode": "build",
        "agent": "build",
        "path": {
          "cwd": "/tmp/sa0-work-5KEWn0",
          "root": "/"
        },
        "cost": 0,
        "tokens": {
          "input": 0,
          "output": 0,
          "reasoning": 0,
          "cache": {
            "write": 0,
            "read": 0
          }
        },
        "modelID": "fake-model",
        "providerID": "fake",
        "time": {
          "created": 1786710301092,
          "completed": 1786710302971
        },
        "sessionID": "ses_sa0probe00000000000root",
        "finish": "tool-calls"
      }
    }
  },
  {
    "id": "evt_0003ba0fe001ZCzvdS2JOpLeNB",
    "type": "session.status",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "status": {
        "type": "busy"
      }
    }
  },
  {
    "id": "evt_0003ba101001IBh6gSimBkm4Uh",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "info": {
        "id": "msg_0003ba101001gT4KSgYu8NdxWc",
        "parentID": "msg_0003b965b001gSbeLPM7axRjo6",
        "role": "assistant",
        "mode": "build",
        "agent": "build",
        "path": {
          "cwd": "/tmp/sa0-work-5KEWn0",
          "root": "/"
        },
        "cost": 0,
        "tokens": {
          "input": 0,
          "output": 0,
          "reasoning": 0,
          "cache": {
            "read": 0,
            "write": 0
          }
        },
        "modelID": "fake-model",
        "providerID": "fake",
        "time": {
          "created": 1786710302977
        },
        "sessionID": "ses_sa0probe00000000000root"
      }
    }
  },
  {
    "id": "evt_0003ba10f001ps6tOvSAh9YCmm",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe0000000000child",
      "info": {
        "role": "user",
        "time": {
          "created": 1786710301973
        },
        "agent": "general",
        "model": {
          "providerID": "fake",
          "modelID": "fake-model"
        },
        "summary": {
          "diffs": []
        },
        "id": "msg_0003b9d12001sv3mzRwub3W4ZM",
        "sessionID": "ses_sa0probe0000000000child"
      }
    }
  },
  {
    "id": "evt_0003ba119001X5w0dMVCMvnKSI",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "info": {
        "role": "user",
        "time": {
          "created": 1786710300251
        },
        "agent": "build",
        "model": {
          "providerID": "fake",
          "modelID": "fake-model"
        },
        "summary": {
          "diffs": []
        },
        "id": "msg_0003b965b001gSbeLPM7axRjo6",
        "sessionID": "ses_sa0probe00000000000root"
      }
    }
  },
  {
    "id": "evt_0003ba132001UN1ppUpP3BUXfn",
    "type": "session.status",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "status": {
        "type": "busy"
      }
    }
  },
  {
    "id": "evt_0003ba13d0012l1N8xfzI0nDfz",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "part": {
        "id": "prt_0003ba13d0012TAGb2PS1pT6eo",
        "messageID": "msg_0003ba101001gT4KSgYu8NdxWc",
        "sessionID": "ses_sa0probe00000000000root",
        "type": "step-start"
      },
      "time": 1786710303037
    }
  },
  {
    "id": "evt_0003ba141001VDjzrHttonM3cV",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "part": {
        "id": "prt_0003ba141001jgjQVR3VGmB6CQ",
        "messageID": "msg_0003ba101001gT4KSgYu8NdxWc",
        "sessionID": "ses_sa0probe00000000000root",
        "type": "text",
        "text": "",
        "time": {
          "start": 1786710303041
        }
      },
      "time": 1786710303041
    }
  },
  {
    "id": "evt_0003ba146001KCZcFBSq7V0mTm",
    "type": "message.part.delta",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "messageID": "msg_0003ba101001gT4KSgYu8NdxWc",
      "partID": "prt_0003ba141001jgjQVR3VGmB6CQ",
      "field": "text",
      "delta": "PARENT DONE"
    }
  },
  {
    "id": "evt_0003ba1470012wqWvQv1DIxuL4",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "part": {
        "id": "prt_0003ba141001jgjQVR3VGmB6CQ",
        "messageID": "msg_0003ba101001gT4KSgYu8NdxWc",
        "sessionID": "ses_sa0probe00000000000root",
        "type": "text",
        "text": "PARENT DONE",
        "time": {
          "start": 1786710303041,
          "end": 1786710303047
        }
      },
      "time": 1786710303047
    }
  },
  {
    "id": "evt_0003ba14b001XUb72UupVOtO8E",
    "type": "message.part.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "part": {
        "id": "prt_0003ba14b001x61yIaF1KVeJ8Z",
        "reason": "stop",
        "messageID": "msg_0003ba101001gT4KSgYu8NdxWc",
        "sessionID": "ses_sa0probe00000000000root",
        "type": "step-finish",
        "tokens": {
          "total": 14,
          "input": 10,
          "output": 4,
          "reasoning": 0,
          "cache": {
            "write": 0,
            "read": 0
          }
        },
        "cost": 0
      },
      "time": 1786710303051
    }
  },
  {
    "id": "evt_0003ba14e001giadp0hPdHnpW9",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "info": {
        "id": "msg_0003ba101001gT4KSgYu8NdxWc",
        "parentID": "msg_0003b965b001gSbeLPM7axRjo6",
        "role": "assistant",
        "mode": "build",
        "agent": "build",
        "path": {
          "cwd": "/tmp/sa0-work-5KEWn0",
          "root": "/"
        },
        "cost": 0,
        "tokens": {
          "total": 14,
          "input": 10,
          "output": 4,
          "reasoning": 0,
          "cache": {
            "write": 0,
            "read": 0
          }
        },
        "modelID": "fake-model",
        "providerID": "fake",
        "time": {
          "created": 1786710302977,
          "completed": 1786710303058
        },
        "sessionID": "ses_sa0probe00000000000root",
        "finish": "stop"
      }
    }
  },
  {
    "id": "evt_0003ba152001GEi5UzZzkGeo46",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "info": {
        "id": "msg_0003ba101001gT4KSgYu8NdxWc",
        "parentID": "msg_0003b965b001gSbeLPM7axRjo6",
        "role": "assistant",
        "mode": "build",
        "agent": "build",
        "path": {
          "cwd": "/tmp/sa0-work-5KEWn0",
          "root": "/"
        },
        "cost": 0,
        "tokens": {
          "total": 14,
          "input": 10,
          "output": 4,
          "reasoning": 0,
          "cache": {
            "write": 0,
            "read": 0
          }
        },
        "modelID": "fake-model",
        "providerID": "fake",
        "time": {
          "created": 1786710302977,
          "completed": 1786710303058
        },
        "sessionID": "ses_sa0probe00000000000root",
        "finish": "stop"
      }
    }
  },
  {
    "id": "evt_0003ba155001c3W1btmE5MlueZ",
    "type": "session.status",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "status": {
        "type": "busy"
      }
    }
  },
  {
    "id": "evt_0003ba158001QOuKA3CQY74L7e",
    "type": "session.status",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "status": {
        "type": "idle"
      }
    }
  },
  {
    "id": "evt_0003ba159001e1QABHhmnA4cco",
    "type": "session.idle",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root"
    }
  },
  {
    "id": "evt_0003ba15f001z0xVphY1nG6I3k",
    "type": "message.updated",
    "properties": {
      "sessionID": "ses_sa0probe00000000000root",
      "info": {
        "role": "user",
        "time": {
          "created": 1786710300251
        },
        "agent": "build",
        "model": {
          "providerID": "fake",
          "modelID": "fake-model"
        },
        "summary": {
          "diffs": []
        },
        "id": "msg_0003b965b001gSbeLPM7axRjo6",
        "sessionID": "ses_sa0probe00000000000root"
      }
    }
  }
];
