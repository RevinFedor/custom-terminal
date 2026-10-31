'use strict';
// Test-only minimal projection of private116's controlled 150ms pointerdown.
// PIDs/tids and clock IDs remapped; only native numeric metadata retained.
// Trusted CDP control, not physical input or a production-cause assertion.
module.exports = {
  "options": {
    "mainPid": 11,
    "rendererPid": 22,
    "documentTimeOriginMs": 1793264276251.3
  },
  "clockMarkers": [
    {
      "syncId": "fixture-clock-0",
      "before": {
        "timeOrigin": 1793264270543.132,
        "now": 7742.788333,
        "epochMs": 1793264278285.921
      },
      "after": {
        "timeOrigin": 1793264270543.132,
        "now": 7743.378833,
        "epochMs": 1793264278286.5112
      }
    },
    {
      "syncId": "fixture-clock-1",
      "before": {
        "timeOrigin": 1793264270543.132,
        "now": 8937.704042,
        "epochMs": 1793264279480.8367
      },
      "after": {
        "timeOrigin": 1793264270543.132,
        "now": 8940.201792,
        "epochMs": 1793264279483.3342
      }
    }
  ],
  "trigger": {
    "rendererPid": 22,
    "documentTimeOriginMs": 1793264276251.3,
    "nativeOriginal": {
      "type": "pointerdown",
      "pointerType": "mouse",
      "timeStampMs": 2570.8999996185303
    }
  },
  "events": [
    {"name":"thread_name","ph":"M","pid":22,"tid":1,"ts":0,"args":{"name":"CrRendererMain"}},
    {"name":"thread_name","ph":"M","pid":22,"tid":2,"ts":0,"args":{"name":"Compositor"}},
    {
      "name": "LatencyInfo.Flow",
      "cat": "input,benchmark,latencyInfo",
      "ph": "X",
      "pid": 22,
      "tid": 1,
      "ts": 2796398175964,
      "dur": 152556,
      "tdur": 151090,
      "args": {
        "chrome_latency_info": {
          "trace_id": 4,
          "step": "STEP_HANDLE_INPUT_EVENT_MAIN"
        }
      }
    },
    {
      "name": "WebFrameWidgetImpl::HandleInputEvent",
      "cat": "input,rail",
      "ph": "X",
      "pid": 22,
      "tid": 1,
      "ts": 2796398175969,
      "dur": 152535,
      "tdur": 151069,
      "args": {
        "type": "MouseDown"
      }
    },
    {
      "name": "clock_sync",
      "cat": "__metadata",
      "ph": "c",
      "pid": 11,
      "tid": 1,
      "ts": 2796397639888,
      "args": {
        "sync_id": "fixture-clock-0"
      }
    },
    {
      "name": "clock_sync",
      "cat": "__metadata",
      "ph": "c",
      "pid": 11,
      "tid": 1,
      "ts": 2796398836264,
      "args": {
        "sync_id": "fixture-clock-1"
      }
    },
    {
      "name": "InputLatency::MouseDown",
      "cat": "benchmark,latencyInfo,rail,input.scrolling",
      "ph": "b",
      "pid": 11,
      "tid": 1,
      "ts": 2796398175686,
      "id": "0x2c",
      "args": {
        "chrome_latency_info": {
          "trace_id": 4,
          "is_coalesced": false,
          "component_info": [
            {
              "component_type": "COMPONENT_INPUT_EVENT_LATENCY_BEGIN_RWH",
              "time_us": 2796398175719
            },
            {
              "component_type": "COMPONENT_INPUT_EVENT_LATENCY_ORIGINAL",
              "time_us": 2796398175686
            },
            {
              "component_type": "COMPONENT_INPUT_EVENT_LATENCY_RENDERER_MAIN",
              "time_us": 2796398175966
            },
            {
              "component_type": "COMPONENT_INPUT_EVENT_LATENCY_RENDERING_SCHEDULED_MAIN",
              "time_us": 2796398176038
            }
          ]
        }
      }
    },
    {
      "name": "EventLatency",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398175686,
      "id2": {
        "local": "0x2d"
      },
      "args": {
        "event_latency": {
          "event_latency_id": 4,
          "event_type": "MOUSE_PRESSED"
        }
      }
    },
    {
      "name": "GenerationToBrowserMain",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398175686,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "GenerationToBrowserMain",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398175719,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "BrowserMainToRendererCompositor",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398175719,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "BrowserMainToRendererCompositor",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398175873,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "RendererCompositorQueueingDelay",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398175873,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "RendererCompositorQueueingDelay",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398175896,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "RendererCompositorProcessing",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398175896,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "RendererCompositorProcessing",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398175905,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "RendererCompositorToMain",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398175905,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "RendererCompositorToMain",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398175967,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "RendererMainProcessing",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398175967,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "RendererMainProcessing",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398328506,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "RendererMainFinishedToBeginImplFrame",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398328506,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "InputLatency::MouseDown",
      "cat": "benchmark,latencyInfo,rail,input.scrolling",
      "ph": "e",
      "pid": 11,
      "tid": 1,
      "ts": 2796398329575,
      "id": "0x2c",
      "args": {}
    },
    {
      "name": "RendererMainFinishedToBeginImplFrame",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398352624,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "BeginImplFrameToSendBeginMainFrame",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398352624,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "BeginImplFrameToSendBeginMainFrame",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398352636,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "SendBeginMainFrameToCommit",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398352636,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "SendBeginMainFrameToCommit",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398354438,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "Commit",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398354438,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "Commit",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398354464,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "EndCommitToActivation",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398354464,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "EndCommitToActivation",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398354759,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "Activation",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398354759,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "Activation",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398354789,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "EndActivateToSubmitCompositorFrame",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398354789,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "EndActivateToSubmitCompositorFrame",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398360528,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "SubmitCompositorFrameToPresentationCompositorFrame",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398360528,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "SubmitToReceiveCompositorFrame",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398360528,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "SubmitToReceiveCompositorFrame",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398360670,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "ReceiveCompositorFrameToStartDraw",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398360670,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "ReceiveCompositorFrameToStartDraw",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398360731,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "StartDrawToSwapStart",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398360731,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "StartDrawToSwapStart",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398361865,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "Swap",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "b",
      "pid": 22,
      "tid": 2,
      "ts": 2796398361865,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "Swap",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398362114,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "SubmitCompositorFrameToPresentationCompositorFrame",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398362114,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    },
    {
      "name": "EventLatency",
      "cat": "cc,benchmark,input,input.scrolling",
      "ph": "e",
      "pid": 22,
      "tid": 2,
      "ts": 2796398362137,
      "id2": {
        "local": "0x2d"
      },
      "args": {}
    }
  ]
};
