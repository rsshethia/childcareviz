// Peek SA2 shapefile properties. Usage: npx tsx scripts/sa2-peek.mts
import * as shapefile from 'shapefile';
const src = await shapefile.open('data/abs/sa2_shp/SA2_2021_AUST_GDA2020.shp', 'data/abs/sa2_shp/SA2_2021_AUST_GDA2020.dbf');
let n = 0;
let r = await src.read();
while (!r.done && n < 3) {
  console.log('type:', r.value.geometry.type, 'props:', JSON.stringify(r.value.properties));
  const b = r.value.bbox;
  console.log('bbox:', b);
  n++;
  r = await src.read();
}
console.log('first features ok');
