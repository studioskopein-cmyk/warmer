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
    return{r:r.value,mm:mm.value,rCount:r.count,mmCount:mm.count};
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
  const rainSeries=hours.map((pt,i)=>({hour:pt.hour,rain:rainHourly[i].r}));
  const availableRain=rainHourly.map(pt=>pt.r).filter(Number.isFinite);
  const maxRain=availableRain.length?Math.max(...availableRain):null;
  const maxSpread=modelMaxToday.length>1?Math.max(...modelMaxToday)-Math.min(...modelMaxToday):0;
  const rainSpread=Math.max(0,...hours.map((_,i)=>{
    const values=hourlyByModel.map(x=>x.hourly[i].r).filter(Number.isFinite);
    return values.length>1?Math.max(...values)-Math.min(...values):0;
  }));
  const consensus=rainSpread>=40&&maxRain>=45?'RAIN_SPLIT':maxSpread>=4.5?'LOW':maxSpread>=2.5?'MEDIUM':'HIGH';
  return{tMax,tMin,yMax,tCode:daily('weathercode',primaryId,today)??0,feels,wind,gust,dewPoint,slots,diff:tMax-yMax,
    now,nowHour:h,timeZone,band,forecastWindow:'next24h',primaryModel:primaryId,todayMorningTemp:tempAtHour(8),tomorrowMorningTemp:tempAtHour(8,1),hourlyByModel,maxSpread,rainSpread,maxRain,rainSeries,
    consensus,modelMaxToday,uvIndex,humidity,europeanAqi:airQuality.europeanAqi,pollenSpecies:airQuality.pollenSpecies};
}
