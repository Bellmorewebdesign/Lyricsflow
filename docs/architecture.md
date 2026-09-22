# Architecture

The MV3 service worker owns the WebSocket to Atlas and routes messages to the YouTube Music content script. The content script reads the actual HTMLMediaElement and player bar. Atlas accepts one active source, owns a versioned snapshot, fetches and caches LRCLIB line timed lyrics, and broadcasts snapshots to display clients. The display has a single persistent page with a state machine and local monotonic playback interpolation. No song text or audio goes to the tablet except matched timed lines. A command returns an ACK for delivery only; actual playback is confirmed by subsequent source state.

Protocol v1 is in `shared/protocol.ts`. Only validated messages cross role boundaries. A source disconnect invalidates interpolation, and a new source starts with a blank snapshot. The simulator uses a loopback source connection, never production display UI.
