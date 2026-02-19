import subprocess
import time

# FFmpeg command: capture from USB mic (ALSA hw:1,0) and stream raw PCM over UDP
FFMPEG_CMD = [
    "ffmpeg",
    "-f", "alsa",       # ALSA input
    "-channels", "1",   # force mono input
    "-i", "hw:1,0",     # USB Microphone (card 1, device 0)
    "-ac", "1",         # mono output
    "-ar", "48000",     # 48 kHz sample rate
    "-f", "s16le",      # raw signed 16-bit PCM, little-endian (no WAV header)
    "-loglevel", "error",
    "-hide_banner",
    "udp://10.0.0.101:5002"  # Yui server LAN IP
]


def start_stream():
    """Launch FFmpeg and return the process handle."""
    print("🎤 Starting UDP audio stream...")
    return subprocess.Popen(FFMPEG_CMD, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)


def monitor_stream():
    """Watch the FFmpeg process and restart it on crash."""
    while True:
        process = start_stream()

        for line in process.stderr:
            print(line.strip())
            if "Invalid argument" in line or "Error" in line:
                print("⚠️ Error detected, restarting stream...")
                process.terminate()
                time.sleep(2)
                break

        print("⏳ FFmpeg stopped, restarting...")
        time.sleep(2)


if __name__ == "__main__":
    monitor_stream()
