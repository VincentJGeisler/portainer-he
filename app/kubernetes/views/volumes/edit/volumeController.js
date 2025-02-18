import angular from 'angular';
import _ from 'lodash-es';
import filesizeParser from 'filesize-parser';
import KubernetesVolumeHelper from 'Kubernetes/helpers/volumeHelper';
import KubernetesEventHelper from 'Kubernetes/helpers/eventHelper';
import { KubernetesStorageClassAccessPolicies } from 'Kubernetes/models/storage-class/models';
import KubernetesNamespaceHelper from 'Kubernetes/helpers/namespaceHelper';
import { confirmRedeploy } from '@/react/kubernetes/volumes/ItemView/ConfirmRedeployModal';
import { isVolumeUsed } from '@/react/kubernetes/volumes/utils';

class KubernetesVolumeController {
  /* @ngInject */
  constructor(
    $async,
    $state,
    Notifications,
    LocalStorage,
    KubernetesVolumeService,
    KubernetesEventService,
    KubernetesApplicationService,
    KubernetesPersistentVolumeClaimService,
    KubernetesPodService
  ) {
    this.$async = $async;
    this.$state = $state;
    this.Notifications = Notifications;
    this.LocalStorage = LocalStorage;

    this.KubernetesVolumeService = KubernetesVolumeService;
    this.KubernetesEventService = KubernetesEventService;
    this.KubernetesApplicationService = KubernetesApplicationService;
    this.KubernetesPersistentVolumeClaimService = KubernetesPersistentVolumeClaimService;
    this.KubernetesPodService = KubernetesPodService;

    this.onInit = this.onInit.bind(this);
    this.getVolume = this.getVolume.bind(this);
    this.getVolumeAsync = this.getVolumeAsync.bind(this);
    this.updateVolumeAsync = this.updateVolumeAsync.bind(this);
    this.getEvents = this.getEvents.bind(this);
    this.getEventsAsync = this.getEventsAsync.bind(this);
  }

  selectTab(index) {
    this.LocalStorage.storeActiveTab('volume', index);
  }

  showEditor() {
    this.state.showEditorTab = true;
    this.selectTab(2);
  }

  isExternalVolume() {
    return !this.volume.PersistentVolumeClaim.ApplicationOwner;
  }

  isSystemNamespace() {
    return KubernetesNamespaceHelper.isSystemNamespace(this.volume.ResourcePool.Namespace.Name);
  }

  isUsed() {
    return isVolumeUsed(this.volume);
  }

  onChangeSize() {
    if (this.state.volumeSize) {
      const size = filesizeParser(this.state.volumeSize + this.state.volumeSizeUnit, { base: 10 });
      if (this.state.oldVolumeSize > size) {
        this.state.errors.volumeSize = true;
      } else {
        this.state.errors.volumeSize = false;
      }
    }
  }

  sizeIsValid() {
    return !this.state.errors.volumeSize && this.state.volumeSize && this.state.oldVolumeSize !== filesizeParser(this.state.volumeSize + this.state.volumeSizeUnit, { base: 10 });
  }

  /**
   * VOLUME
   */

  async updateVolumeAsync(redeploy) {
    try {
      this.volume.PersistentVolumeClaim.Storage = this.state.volumeSize + this.state.volumeSizeUnit.charAt(0);
      await this.KubernetesPersistentVolumeClaimService.patch(this.oldVolume.PersistentVolumeClaim, this.volume.PersistentVolumeClaim);
      this.Notifications.success('Success', 'Volume successfully updated');

      if (redeploy) {
        const promises = _.flatten(
          _.map(this.volume.Applications, (app) => {
            return _.map(app.Pods, (item) => this.KubernetesPodService.delete(item));
          })
        );
        await Promise.all(promises);
        this.Notifications.success('Success', 'Applications successfully redeployed');
      }

      this.$state.reload(this.$state.current);
    } catch (err) {
      this.Notifications.error('Failure', err, 'Unable to update volume.');
    }
  }

  updateVolume() {
    if (isVolumeUsed(this.volume)) {
      confirmRedeploy().then((redeploy) => {
        return this.$async(this.updateVolumeAsync, redeploy);
      });
    } else {
      return this.$async(this.updateVolumeAsync, false);
    }
  }

  async getVolumeAsync() {
    const storageClasses = this.endpoint.Kubernetes.Configuration.StorageClasses;
    try {
      const [volume, applications] = await Promise.all([
        this.KubernetesVolumeService.get(this.state.namespace, storageClasses, this.state.name),
        this.KubernetesApplicationService.get(this.state.namespace),
      ]);
      volume.Applications = KubernetesVolumeHelper.getUsingApplications(volume, applications);
      this.volume = volume;
      this.oldVolume = angular.copy(volume);
      this.state.volumeSize = parseInt(volume.PersistentVolumeClaim.Storage.slice(0, -2), 10);
      this.state.volumeSizeUnit = volume.PersistentVolumeClaim.Storage.slice(-2);
      this.state.oldVolumeSize = filesizeParser(volume.PersistentVolumeClaim.Storage, { base: 10 });
    } catch (err) {
      this.Notifications.error('Failure', err, 'Unable to retrieve volume');
    }
  }

  getVolume() {
    return this.$async(this.getVolumeAsync);
  }

  /**
   * EVENTS
   */
  hasEventWarnings() {
    return this.state.eventWarningCount;
  }

  async getEventsAsync() {
    try {
      this.state.eventsLoading = true;
      const events = await this.KubernetesEventService.get(this.state.namespace);
      this.events = _.filter(events, (event) => event.Involved.uid === this.volume.PersistentVolumeClaim.Id);
      this.state.eventWarningCount = KubernetesEventHelper.warningCount(this.events);
    } catch (err) {
      this.Notifications.error('Failure', err, 'Unable to retrieve application related events');
    } finally {
      this.state.eventsLoading = false;
    }
  }

  getEvents() {
    return this.$async(this.getEventsAsync);
  }

  /**
   * ON INIT
   */
  async onInit() {
    this.state = {
      activeTab: 0,
      currentName: this.$state.$current.name,
      showEditorTab: false,
      eventsLoading: true,
      viewReady: false,
      namespace: this.$transition$.params().namespace,
      name: this.$transition$.params().name,
      eventWarningCount: 0,
      availableSizeUnits: ['MB', 'GB', 'TB'],
      increaseSize: false,
      volumeSize: 0,
      volumeSizeUnit: 'GB',
      volumeSharedAccessPolicies: [],
      volumeSharedAccessPolicyTooltips: '',
      errors: {
        volumeSize: false,
      },
    };

    this.state.activeTab = this.LocalStorage.getActiveTab('volume');

    try {
      await this.getVolume();
      await this.getEvents();
      if (this.volume.PersistentVolumeClaim.storageClass !== undefined) {
        this.state.volumeSharedAccessPolicies = this.volume.PersistentVolumeClaim.AccessModes;
        let policies = KubernetesStorageClassAccessPolicies();
        this.state.volumeSharedAccessPolicyTooltips = this.state.volumeSharedAccessPolicies.map((policy) => {
          const matchingPolicy = policies.find((p) => p.Name === policy);
          return matchingPolicy ? matchingPolicy.Description : undefined;
        });
      }
    } catch (err) {
      this.Notifications.error('Failure', err, 'Unable to load view data');
    } finally {
      this.state.viewReady = true;
    }
  }

  $onInit() {
    return this.$async(this.onInit);
  }

  $onDestroy() {
    if (this.state.currentName !== this.$state.$current.name) {
      this.LocalStorage.storeActiveTab('volume', 0);
    }
  }
}

export default KubernetesVolumeController;
angular.module('portainer.kubernetes').controller('KubernetesVolumeController', KubernetesVolumeController);
