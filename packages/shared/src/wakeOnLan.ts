import dgram from 'dgram';

/** Build a Wake-on-LAN magic packet (6×0xFF + MAC×16) for `mac`. */
export function buildMagicPacket(mac: string): Buffer {
    const hex = mac.replace(/[:\-]/g, '');
    if (hex.length !== 12) throw new Error(`Invalid MAC: ${mac}`);
    const macBytes = Buffer.from(hex, 'hex');
    const magic = Buffer.alloc(6 + 16 * 6);
    magic.fill(0xff, 0, 6);
    for (let i = 0; i < 16; i++) macBytes.copy(magic, 6 + i * 6);
    return magic;
}

/** Send a WoL magic packet to `mac`, broadcast on the /24 subnet of `ip`. */
export function wakeOnLan(mac: string, ip: string): Promise<void> {
    return new Promise((resolve, reject) => {
        let magic: Buffer;
        try {
            magic = buildMagicPacket(mac);
        } catch (e) {
            reject(e);
            return;
        }
        const broadcast = ip.replace(/\.\d+$/, '.255');
        const sock = dgram.createSocket('udp4');
        sock.once('error', reject);
        sock.bind(() => {
            sock.setBroadcast(true);
            sock.send(magic, 9, broadcast, (err) => {
                sock.close();
                if (err) reject(err);
                else resolve();
            });
        });
    });
}
