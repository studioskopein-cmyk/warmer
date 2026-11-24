export const MODELS=[
  {id:'ecmwf_ifs025',label:'ECMWF',opacity:1,width:2.5,dash:null,primary:true},
  {id:'icon_seamless',label:'ICON',opacity:0.7,width:1.2,dash:'7,4'},
  {id:'gfs_seamless',label:'GFS',opacity:0.65,width:1,dash:'0.1,4'},
];

export function getTimeBand(date=new Date()){
  const h=typeof date==='number'?date:date.getHours();
  return h<5?'NIGHT':h<11?'MORNING':h<18?'DAY':'EVENING';
}

export function getBandWindow(band,nowHour){
  const range=(from,to,dayOffset=0)=>Array.from({length:Math.max(0,to-from+1)},(_,i)=>({dayOffset,hour:from+i}));
  if(band==='EVENING')return[...range(nowHour,23),...range(0,11,1)];
  return range(nowHour,band==='NIGHT'?11:23);
}

export function locationClock(now,timeZone){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const at=type=>parts.find(p=>p.type===type).value;
  return{date:`${at('year')}-${at('month')}-${at('day')}`,hour:Number(at('hour'))};
}

function intervalIndex(times,now){
  const seconds=now.getTime()/1000;
  return times?.findIndex(t=>Number.isFinite(t)&&t<=seconds&&seconds<t+3600)??-1;
}

export function parseAirQuality(data,now){
  const empty={uvIndex:null,europeanAqi:null,pollenSpecies:{grass:null,birch:null,alder:null,mugwort:null,olive:null,ragweed:null}};
  if(!data||data.error||!data.hourly)return empty;
  const idx=intervalIndex(data.hourly.time,now);
  const at=key=>{const v=data.hourly[key]?.[idx];return Number.isFinite(v)?v:null};
  return{
    uvIndex:at('uv_index')!=null?Math.round(at('uv_index')*10)/10:null,
    europeanAqi:at('european_aqi')!=null?Math.round(at('european_aqi')):null,
    pollenSpecies:Object.fromEntries(Object.keys(empty.pollenSpecies).map(k=>[k,at(`${k}_pollen`)])),
  };
}

// Missing probability and amount have separate denominators, never zero-filled.
export function avgRainHourly(hourlyByModel){
  const mean=values=>{const available=values.filter(Number.isFinite);return{value:available.length?available.reduce((a,b)=>a+b,0)/available.length:null,count:available.length}};
  return Array.from({length:24},(_,i)=>{
    const r=mean(hourlyByModel.map(x=>x.hourly[i]?.r));
    const mm=mean(hourlyByModel.map(x=>x.hourly[i]?.mm));
    const cm=mean(hourlyByModel.map(x=>x.hourly[i]?.sn));
    return{r:r.value,mm:mm.value,cm:cm.value,rCount:r.count,mmCount:mm.count};
  });
}

export function parse(data,airData,now=new Date()){
  if(!data||data.error)throw new Error(data?.reason||'API error');
  const times=data.hourly?.time;
  const current=intervalIndex(times,now);
  if(current<0)throw new Error('Current hourly forecast is unavailable');
  const timeZone=data.timezone||'UTC';
  const local=locationClock(now,timeZone),h=local.hour,band=getTimeBand(h);
  const calendarOffset=date=>Math.round((Date.parse(date)-Date.parse(local.date))/86400000);
  const hours=times.slice(current,current+24).map(time=>{
    const c=locationClock(new Date(time*1000),timeZone);
    return{time,hour:c.hour+24*calendarOffset(c.date)};
  });
  const at=(key,model,idx)=>{const v=data.hourly[`${key}_${model}`]?.[idx];return Number.isFinite(v)?v:null};
  const hourlyByModel=MODELS.map(model=>({model,hourly:hours.map((hour,i)=>({
    ...hour,t:at('temperature_2m',model.id,current+i),
    // Open-Meteo labels precipitation by the END of its preceding hour.
    r:at('precipitation_probability',model.id,current+i+1),mm:at('precipitation',model.id,current+i+1),
    sn:at('snowfall',model.id,current+i+1),
  }))}));
  const primary=hourlyByModel.find(x=>Number.isFinite(x.hourly[0]?.t));
  if(!primary)throw new Error('Hourly temperature forecast is unavailable');
  const primaryId=primary.model.id;
  const dailyDate=t=>new Date((t+(data.utc_offset_seconds||0))*1000).toISOString().slice(0,10);
  const today=data.daily?.time?.findIndex(t=>dailyDate(t)===local.date)??-1;
  const daily=(key,id,idx)=>{const v=data.daily?.[`${key}_${id}`]?.[idx];return Number.isFinite(v)?v:null};
  const modelMaxToday=MODELS.map(m=>daily('temperature_2m_max',m.id,today)).filter(Number.isFinite);
  const window=getBandWindow(band,h);
  const temps=times.map((time,i)=>{
    if(i<current)return null;
    const c=locationClock(new Date(time*1000),timeZone);
    return window.some(w=>w.hour===c.hour&&w.dayOffset===calendarOffset(c.date))?at('temperature_2m',primaryId,i):null;
  }).filter(Number.isFinite);
  const tMax=Math.round(Math.max(...(temps.length?temps:primary.hourly.map(pt=>pt.t).filter(Number.isFinite))));
  const tMin=temps.length?Math.round(Math.min(...temps)):null;
  const yMax=Math.round(daily('temperature_2m_max',primaryId,today-1)??tMax);
  const tempAtHour=(hour,dayOffset=0)=>{
    const idx=times.findIndex(time=>{const c=locationClock(new Date(time*1000),timeZone);return c.hour===hour&&calendarOffset(c.date)===dayOffset});
    const v=at('temperature_2m',primaryId,idx);return v==null?null:Math.round(v);
  };
  const slots=[{label:'morning',h:8},{label:'midday',h:13},{label:'evening',h:19}].map(s=>({...s,temp:tempAtHour(s.h)}));
  const feels=Math.round(at('apparent_temperature',primaryId,current)??primary.hourly[0].t);
  const wind=Math.round(at('windspeed_10m',primaryId,current)??0);
  const gust=at('wind_gusts_10m',primaryId,current);
  const dewPoint=at('dew_point_2m',primaryId,current);
  const humidity=at('relative_humidity_2m',primaryId,current);
  const airQuality=parseAirQuality(airData,now);
  const uvIndex=airQuality.uvIndex??at('uv_index','gfs_seamless',current);
  const rainHourly=avgRainHourly(hourlyByModel);
  // Hourly context for the next 24 hours: what falls (rain/snow/code), how
  // it feels, gusts and UV. inWindow marks the hours the day's advice covers
  // (getBandWindow): the rest of today, or until noon tomorrow after 18:00.
  const airTimes=airData?.hourly?.time||[];
  const winKeys=new Set(window.map(w=>w.hour+24*w.dayOffset));
  const rainSeries=hours.map((pt,i)=>{
    const ai=airTimes.indexOf(pt.time),airUv=ai>=0?airData.hourly.uv_index?.[ai]:null;
    return{hour:pt.hour,time:pt.time,rain:rainHourly[i].r,mm:rainHourly[i].mm,cm:rainHourly[i].cm,
      t:at('temperature_2m',primaryId,current+i),feels:at('apparent_temperature',primaryId,current+i),
      gust:at('wind_gusts_10m',primaryId,current+i)??at('wind_gusts_10m','icon_seamless',current+i),
      code:at('weathercode',primaryId,current+i+1)??at('weathercode','icon_seamless',current+i+1),
      uv:Number.isFinite(airUv)?airUv:at('uv_index','gfs_seamless',current+i),
      inWindow:i===0||winKeys.has(pt.hour)};
  });
  const win=rainSeries.filter(pt=>pt.inWindow);
  const extreme=(key,fn,pts=win)=>{let best=null;for(const pt of pts)if(Number.isFinite(pt[key])&&(best==null||fn(pt[key],best[key])))best=pt;return best};
  const feelsHi=extreme('feels',(a,b)=>a>b),feelsLo=extreme('feels',(a,b)=>a<b),gustHi=extreme('gust',(a,b)=>a>b);
  const uvHi=extreme('uv',(a,b)=>a>b,win.filter(pt=>pt.hour%24>=9&&pt.hour%24<=16));
  const thunderAt=win.find(pt=>pt.code>=95&&pt.code<=99&&(pt.rain??0)>=40);
  const winT=win.map(pt=>pt.t).filter(Number.isFinite);
  const ahead={
    feelsMax:feelsHi?{value:Math.round(feelsHi.feels),hour:feelsHi.hour}:null,
    feelsMin:feelsLo?{value:Math.round(feelsLo.feels),hour:feelsLo.hour}:null,
    gustMax:gustHi?{value:Math.round(gustHi.gust),hour:gustHi.hour}:null,
    uvMax:uvHi?{value:Math.round(uvHi.uv*10)/10,hour:uvHi.hour}:null,
    thunder:thunderAt?{hour:thunderAt.hour,chance:Math.round(thunderAt.rain)}:null,
    freezingRain:win.some(pt=>pt.code===66||pt.code===67),
    swing:winT.length?Math.round(Math.max(...winT)-Math.min(...winT)):0,
    tLow:winT.length?Math.round(Math.min(...winT)):null,
    snowCm:Math.round(win.reduce((sum,pt)=>sum+(Number.isFinite(pt.cm)?pt.cm:0),0)*10)/10,
  };
  const availableRain=rainHourly.map(pt=>pt.r).filter(Number.isFinite);
  const maxRain=availableRain.length?Math.max(...availableRain):null;
  const maxSpread=modelMaxToday.length>1?Math.max(...modelMaxToday)-Math.min(...modelMaxToday):0;
  const rainSpread=Math.max(0,...hours.map((_,i)=>{
    const values=hourlyByModel.map(x=>x.hourly[i].r).filter(Number.isFinite);
    return values.length>1?Math.max(...values)-Math.min(...values):0;
  }));
  const consensus=rainSpread>=40&&maxRain>=45?'RAIN_SPLIT':maxSpread>=4.5?'LOW':maxSpread>=2.5?'MEDIUM':'HIGH';
  // Current reading and the same local hour yesterday (past_days=1 covers it); drives the top bar.
  const nowTemp=Math.round(primary.hourly[0].t);
  const yesterdayNowTemp=tempAtHour(h,-1);
  return{tMax,tMin,yMax,nowTemp,yesterdayNowTemp,tCode:daily('weathercode',primaryId,today)??0,feels,wind,gust,dewPoint,slots,diff:Number.isFinite(yesterdayNowTemp)?nowTemp-yesterdayNowTemp:tMax-yMax,
    now,nowHour:h,timeZone,band,forecastWindow:'next24h',primaryModel:primaryId,todayMorningTemp:tempAtHour(8),tomorrowMorningTemp:tempAtHour(8,1),hourlyByModel,maxSpread,rainSpread,maxRain,rainSeries,
    consensus,modelMaxToday,uvIndex,ahead,humidity,europeanAqi:airQuality.europeanAqi,pollenSpecies:airQuality.pollenSpecies};
}
