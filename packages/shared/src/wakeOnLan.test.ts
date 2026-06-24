import assert from 'assert';
import { buildMagicPacket } from './wakeOnLan';

async function run() {
    // 6 octets 0xFF puis 16 répétitions de la MAC
    {
        const pkt = buildMagicPacket('D0:D0:03:30:48:4B');
        assert.strictEqual(pkt.length, 102);
        assert.deepStrictEqual(
            [...pkt.subarray(0, 6)],
            [0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
        );
        // premier octet de la MAC répétée = 0xD0
        assert.strictEqual(pkt[6], 0xd0);
        assert.strictEqual(pkt[7], 0xd0);
        assert.strictEqual(pkt[8], 0x03);
        // dernière répétition commence à l'offset 6 + 15*6 = 96
        assert.strictEqual(pkt[96], 0xd0);
        assert.strictEqual(pkt[101], 0x4b);
    }
    // accepte les MAC avec tirets
    {
        const pkt = buildMagicPacket('D0-D0-03-30-48-4B');
        assert.strictEqual(pkt.length, 102);
    }
    // MAC invalide → throw
    {
        assert.throws(() => buildMagicPacket('xx:yy'));
    }
    console.log('All wakeOnLan tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
