import { authorizeOperation, sameTeamUser, teamOperationRoles } from './runtime-identity.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { assertOzonAccountDiscoveryBinding, OzonAccountReadError } from './ozon-account-read-contract.mjs';
import { OZON_ACCOUNT_OFFICIAL_CONTRACT_REFS } from './ozon-account-read-preparation.mjs';
import { createOzonAccountDiscoveryServices } from './ozon-account-discovery-services.mjs';

/** Compose explicitly configured account routes. Construction performs no account read. */
export function createConfiguredOzonAccountDiscoveryRuntime({configuration,repository,workerRegistry,serverClock,requestJson}) {
  const bindings=configuration.ozonAccountDiscoveryBindings.map(route=>{
    const credentials=configuration.ozonDECredentialBindings.filter(value=>value.credentialAlias===route.credentialAlias);
    if(credentials.length!==1)throw new OzonAccountReadError('CREDENTIAL_CONFIGURATION_AMBIGUOUS');
    const fields={bindingId:route.bindingId,configurationVersion:route.configurationVersion,platform:'ozon',
      targetStore:route.targetStore,storeIdentityStatus:'unverified',credentialAlias:route.credentialAlias,
      clientIdRef:`ozon-client-configuration:${fingerprintCanonicalRecord(credentials[0])}`,
      officialContractRefs:{...OZON_ACCOUNT_OFFICIAL_CONTRACT_REFS}};
    return {binding:assertOzonAccountDiscoveryBinding({...fields,scopeRef:`ozon-account-discovery-scope:${fingerprintCanonicalRecord(fields)}`}),
      storeName:route.storeName,clientId:credentials[0].clientId};
  });
  function loadCurrentReadBinding({bindingId,configurationVersion}) {
    const matches=bindings.filter(value=>value.binding.bindingId===bindingId&&value.binding.configurationVersion===configurationVersion);
    if(matches.length>1)throw new OzonAccountReadError('BINDING_AMBIGUOUS');
    return matches.length===0?null:structuredClone(matches[0].binding);
  }
  const services=new Map(configuration.ozonAccountDiscoveryBindings.map(route=>[route.bindingId,
    createOzonAccountDiscoveryServices({repository,workerRegistry,serverClock,requestJson,loadCurrentReadBinding,
      worker:{workerId:route.workerId,version:route.workerVersion,leaseDurationMs:route.leaseDurationMs},
      listBindings:()=>bindings.map(value=>({...structuredClone(value.binding),storeName:value.storeName,clientId:value.clientId}))})]));
  function serviceFor(bindingId) {
    const service=services.get(bindingId);
    if(!service)throw new OzonAccountReadError('SERVICE_NOT_CONFIGURED');
    return service;
  }
  async function serviceForPreparation(input) {
    const document=await repository.readSnapshot();
    const preparation=document.runtime.ozonAccountPreparations?.[input?.preparationId];
    if(!preparation)throw new OzonAccountReadError('PREPARATION_REQUIRED');
    return serviceFor(preparation.binding.bindingId);
  }
  return Object.freeze({
    view({document,actor}) {
      authorizeOperation({actor,requiredRoles: teamOperationRoles(actor)});
      if(actor.actorType!=='human'||actor.source!=='authenticated_identity_provider')throw new OzonAccountReadError('AUTHENTICATED_OWNER_REQUIRED');
      if(services.size>0)return services.values().next().value.view({document,actor});
      const saved=document.runtime.ozonAccountPreparations;
      if(saved!==undefined&&(saved===null||typeof saved!=='object'||Array.isArray(saved)))throw new OzonAccountReadError('REPOSITORY_INVALID');
      if(Object.values(saved??{}).some(value=>sameTeamUser(value.createdByUserId,actor.userId)))throw new OzonAccountReadError('SERVICE_NOT_CONFIGURED');
      return {schemaVersion:'ozon-account-discovery-view-v1',bindings:[],preparations:[],platformWrites:0};
    },
    createPreparation:({actor,input})=>serviceFor(input?.bindingId).createPreparation({actor,input}),
    authorizeAndRun:({actor,input})=>serviceFor(input?.bindingId).authorizeAndRun({actor,input}),
    async continueSavedRead({actor,input}) {return (await serviceForPreparation(input)).continueSavedRead({actor,input});},
    async selectWarehouse({actor,input}) {return (await serviceForPreparation(input)).selectWarehouse({actor,input});}
  });
}
