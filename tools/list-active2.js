// Lists the Active 2 variants the Zepp CLI knows about, with their deviceSource
// ids — the numbers that go into app.json under `platforms`.
const fs = require('fs');
const os = require('os');
const path = require('path');

const file = process.env.ZEUS_DEVICES || path.join(os.homedir(), '.zepp', '.zeus_devices');
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
d.devices
  .filter((x) => /Active 2/i.test(x.productName || ''))
  .forEach((x) => {
    const v = x.value || {};
    console.log(
      [
        x.deviceSource,
        x.code,
        x.productName,
        v.shape,
        v.screen && v.screen.size,
        'nfc=' + v.nfc,
        'api=' + (v.os && v.os.apiLevel),
      ].join(' | ')
    );
  });
