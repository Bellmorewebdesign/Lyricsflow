param(
    [string]$ServerUrl = "ws://192.168.1.14:8777/ws",
    [switch]$TestAudio
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "Run this companion on the Windows playback desktop." }
$uri = [Uri]$ServerUrl
if ($uri.Scheme -notin @("ws", "wss") -or $uri.AbsolutePath -ne "/ws") {
    throw "ServerUrl must be a ws:// or wss:// address ending in /ws."
}

# Windows Core Audio controls the default playback device's master level,
# independent of any browser or application's own volume slider.
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int GetChannelCount(out uint count);
    [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid context);
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
    [PreserveSig] int GetMasterVolumeLevel(out float level);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int SetChannelVolumeLevel(uint channel, float level, ref Guid context);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
    [PreserveSig] int GetChannelVolumeLevel(uint channel, out float level);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool muted, ref Guid context);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool muted);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    [PreserveSig] int Activate(ref Guid interfaceId, uint context, IntPtr parameters, out IAudioEndpointVolume volume);
}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int flow, int mask, IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator { }

public sealed class MasterLevel {
    public float Volume;
    public bool Muted;
}

public static class CoreAudioMaster {
    // Resolve the default playback endpoint each time: the desktop user may
    // change speakers or headphones while this companion remains connected.
    static MasterLevel Access(float? requested) {
        IMMDeviceEnumerator enumerator = null;
        IMMDevice device = null;
        IAudioEndpointVolume endpoint = null;
        try {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
            Guid iid = typeof(IAudioEndpointVolume).GUID;
            Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out endpoint));
            if (requested.HasValue) {
                float value = requested.Value;
                if (float.IsNaN(value) || float.IsInfinity(value) || value < 0 || value > 0.75f)
                    throw new ArgumentOutOfRangeException("requested");
                Guid context = Guid.Empty;
                Marshal.ThrowExceptionForHR(endpoint.SetMasterVolumeLevelScalar(value, ref context));
                bool muted;
                Marshal.ThrowExceptionForHR(endpoint.GetMute(out muted));
                if (value > 0 && muted)
                    Marshal.ThrowExceptionForHR(endpoint.SetMute(false, ref context));
            }
            MasterLevel result = new MasterLevel();
            Marshal.ThrowExceptionForHR(endpoint.GetMasterVolumeLevelScalar(out result.Volume));
            Marshal.ThrowExceptionForHR(endpoint.GetMute(out result.Muted));
            return result;
        } finally {
            if (endpoint != null) Marshal.ReleaseComObject(endpoint);
            if (device != null) Marshal.ReleaseComObject(device);
            if (enumerator != null) Marshal.ReleaseComObject(enumerator);
        }
    }
    public static MasterLevel Read() { return Access(null); }
    public static MasterLevel Set(float volume) { return Access(volume); }
}
'@

if ($TestAudio) {
    $level = [CoreAudioMaster]::Read()
    Write-Host "Windows master volume: $([Math]::Round($level.Volume * 100))%; muted: $($level.Muted)"
    return
}

function Send-Message($socket, $message) {
    $json = ConvertTo-Json -InputObject $message -Compress -Depth 4
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $segment = [ArraySegment[byte]]::new($bytes)
    $socket.SendAsync($segment, [Net.WebSockets.WebSocketMessageType]::Text, $true,
        [Threading.CancellationToken]::None).GetAwaiter().GetResult()
}

function Send-MasterState($socket, $level) {
    Send-Message $socket @{ type = "MASTER_VOLUME_STATE"; volume = [double]$level.Volume; muted = [bool]$level.Muted }
}

Write-Host "Lyricsflow Windows master volume companion. Galaxy limit: 75%; desktop can go higher."
while ($true) {
    $socket = New-Object Net.WebSockets.ClientWebSocket
    try {
        $connectTimeout = New-Object Threading.CancellationTokenSource
        $connectTimeout.CancelAfter(5000)
        try { $socket.ConnectAsync($uri, $connectTimeout.Token).GetAwaiter().GetResult() }
        finally { $connectTimeout.Dispose() }
        Send-Message $socket @{ type = "HELLO"; role = "volume"; protocol = 3 }
        $last = [CoreAudioMaster]::Read()
        Send-MasterState $socket $last
        Write-Host "Connected. Windows master volume: $([Math]::Round($last.Volume * 100))%."
        $reportedAt = [DateTime]::UtcNow
        $pingAt = [DateTime]::UtcNow
        $buffer = New-Object byte[] 4096
        $segment = [ArraySegment[byte]]::new($buffer)
        $parts = New-Object IO.MemoryStream
        $receive = $socket.ReceiveAsync($segment, [Threading.CancellationToken]::None)
        while ($socket.State -eq [Net.WebSockets.WebSocketState]::Open) {
            if ($receive.IsCompleted) {
                $result = $receive.GetAwaiter().GetResult()
                if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { break }
                if ($result.MessageType -ne [Net.WebSockets.WebSocketMessageType]::Text -or $parts.Length + $result.Count -gt 16384) { break }
                $parts.Write($buffer, 0, $result.Count)
                if ($result.EndOfMessage) {
                    $json = [Text.Encoding]::UTF8.GetString($parts.ToArray())
                    $parts.SetLength(0)
                    $message = ConvertFrom-Json -InputObject $json
                    if ($message.type -eq "SET_VOLUME" -and $message.id -is [string] -and
                        $message.id -match '^[a-zA-Z0-9_-]{1,80}$') {
                        $value = $message.volume
                        $valid = $value -is [ValueType] -and $value -isnot [bool] -and
                            ![double]::IsNaN([double]$value) -and $value -ge 0 -and $value -le 0.75
                        if ($valid) {
                            try {
                                $last = [CoreAudioMaster]::Set([float]$value)
                                Send-MasterState $socket $last
                                $reportedAt = [DateTime]::UtcNow
                            } catch {
                                Write-Warning "Unable to change Windows master volume: $_"
                                $valid = $false
                            }
                        }
                        Send-Message $socket @{ type = "CONTROL_ACK"; id = $message.id; delivered = [bool]$valid }
                    }
                }
                $receive = $socket.ReceiveAsync($segment, [Threading.CancellationToken]::None)
            }
            $now = [DateTime]::UtcNow
            $current = [CoreAudioMaster]::Read()
            if ([Math]::Abs($current.Volume - $last.Volume) -ge 0.002 -or
                $current.Muted -ne $last.Muted -or ($now - $reportedAt).TotalSeconds -ge 10) {
                Send-MasterState $socket $current
                $last = $current
                $reportedAt = $now
            }
            if (($now - $pingAt).TotalSeconds -ge 20) {
                Send-Message $socket @{ type = "PING" }
                $pingAt = $now
            }
            Start-Sleep -Milliseconds 200
        }
    } catch {
        Write-Warning "Atlas or Windows audio unavailable: $_"
    } finally {
        if ($parts) { $parts.Dispose() }
        $socket.Dispose()
    }
    Start-Sleep -Seconds 2
}
