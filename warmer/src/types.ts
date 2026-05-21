export interface WeatherContext {
  temp: number;
  delta: number;
  tMax: number;
  tMin: number;
  yMax: number;
  yMin: number;
  tCode: number;
  wind: number;
  slots: Array<{
    temp: number;
    code: number;
    rain: number;
  }>;
  highU?: boolean;
  pivot?: string;
  feels?: number;
  windSpeed?: number;
  hourlySlots?: Array<{ temp: number; code: number; rain: number }>;
  volatility?: boolean;
  keyPoint?: string;
  feels_like?: number;
}

export interface DataProof {
  delta?: { display: string };
  time_window?: { display: string };
  feels_like?: { differs_from_actual: boolean; display: string };
}

export interface WarmTranslation {
  hero: string;
  context: string | null;
  action: string | null;
  proof: DataProof;
}

export interface LayeredTranslation {
  quick: string;
  outfit: {
    message: string;
    key_numbers: string;
  };
  detailed: WarmTranslation;
}
