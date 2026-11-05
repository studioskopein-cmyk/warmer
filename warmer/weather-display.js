// Weather rules always receive Celsius; conversion happens only at presentation.
export function temperatureValue(celsius,unit){return Number.isFinite(celsius)?(unit==='F'?celsius*9/5+32:celsius):NaN}
export function formatTemperature(celsius,unit){
  return Number.isFinite(celsius)?`${Math.round(temperatureValue(celsius,unit))}°${unit||''}`:'—';
}
export function formatDelta(celsius,unit){
  return Number.isFinite(celsius)?`${Math.round(celsius*(unit==='F'?9/5:1))}°${unit||''}`:'—';
}
export function formatAmount(mm){
  return !Number.isFinite(mm)?'—':mm>0&&mm<0.1?'<0.1 mm':`${mm.toFixed(1)} mm`;
}
export function formatHourLabel(hour){
  const h=hour%24;
  const label=h===0?'12am':h<12?`${h}am`:h===12?'12pm':`${h-12}pm`;
  return hour>=24?`tomorrow ${label}`:label;
}
