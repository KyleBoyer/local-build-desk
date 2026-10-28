import { Resvg } from '@resvg/resvg-js';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const svg=await readFile('resources/icon.svg','utf8');
const directory='resources/icon.iconset';await mkdir(directory,{recursive:true});
for(const size of [16,32,64,128,256,512,1024]){
  const png=new Resvg(svg,{fitTo:{mode:'width',value:size}}).render().asPng();
  if(size===1024)await writeFile('resources/icon.png',png);
  if(size<=512)await writeFile(`${directory}/icon_${size}x${size}.png`,png);
  if(size>=32)await writeFile(`${directory}/icon_${size/2}x${size/2}@2x.png`,png);
}
execFileSync('iconutil',['-c','icns',directory,'-o','resources/icon.icns']);
