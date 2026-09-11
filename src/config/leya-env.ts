type Environment=Record<string,string|undefined>;
const warned=new Set<string>();

export function preferredEnvironmentValue(
  source:Environment,
  current:string,
  legacy:string,
  warn:(message:string)=>void=console.warn,
):string|undefined{
  const value=source[current]?.trim();
  if(value)return value;
  const fallback=source[legacy]?.trim();
  if(fallback&&!warned.has(legacy)){
    warned.add(legacy);
    warn(`deprecated_environment_variable ${legacy}; use ${current}`);
  }
  return fallback||undefined;
}

export function readLeyaEnvironment(source:Environment=process.env,warn:(message:string)=>void=console.warn){
  return {
    apiUrl:preferredEnvironmentValue(source,'LEYA_API_URL','LEIA_API_URL',warn),
    adminApiKey:preferredEnvironmentValue(source,'LEYA_ADMIN_API_KEY','LEIA_ADMIN_API_KEY',warn),
  };
}
