"use strict";
const async = require("async");
const _ = require("underscore");
const util = require("util");
const EventEmitter = require("events").EventEmitter;
const assert = require("node-opcua-assert").assert;


const AttributeIds        = require("node-opcua-data-model").AttributeIds;
const BrowseDirection     = require("node-opcua-data-model").BrowseDirection;
const QualifiedName       = require("node-opcua-data-model").QualifiedName;
const LocalizedText       = require("node-opcua-data-model").LocalizedText;
const NodeClass           = require("node-opcua-data-model").NodeClass;

const BrowseDescription   = require("node-opcua-service-browse").BrowseDescription;

const resolveNodeId       = require("node-opcua-nodeid").resolveNodeId;
const NodeId              = require("node-opcua-nodeid").NodeId;
const sameNodeId          = require("node-opcua-nodeid").sameNodeId;
const makeNodeId          = require("node-opcua-nodeid").makeNodeId;
const StatusCodes         = require("node-opcua-status-code").StatusCodes;

const browse_service     = require("node-opcua-service-browse");

const lowerFirstLetter    = require("node-opcua-utils").lowerFirstLetter;

const VariableIds = require("node-opcua-constants").VariableIds;

const debugLog = require("node-opcua-debug").make_debugLog(__filename);

//
// some server do not expose the ReferenceType Node in their address space
// ReferenceType are defined by the OPCUA standard and can be prepopulated in the crawler.
// Pre-populating the ReferenceType node in the crawler will also reduce the network traffic.
//
const ReferenceTypeIds = require("node-opcua-constants").ReferenceTypeIds;

/*=
 *
 * @param arr
 * @param maxNode
 * @private
 * @return {*}
 */
function _fetch_elements(arr, maxNode) {
    assert(_.isArray(arr));
    assert(arr.length > 0);
    const high_limit = ( maxNode <= 0) ? arr.length : maxNode;
    const tmp = arr.splice(0, high_limit);
    assert(tmp.length > 0);
    return tmp;
}

/**
 * @class NodeCrawler
 * @param session
 * @constructor
 */
function NodeCrawler(session) {

    const self = this;

    self.session = session;
    // verify that session object provides the expected methods (browse/read)
    assert(_.isFunction(session.browse));
    assert(_.isFunction(session.read));

    self.browseNameMap = {};
    self._nodesToReadEx = [];
    self._objectCache = {};
    self._objectToBrowse = [];
    self._objMap = {};

    this._initialize_referenceTypeId();

    self.q = async.queue(function (task, callback) {

        // use process next tick to relax the stack frame
        setImmediate(function () {
            task.func.call(self, task, function () {
                self.resolve_deferred_browseNode();
                self.resolve_deferred_readNode();
                callback();
            });
        });

    }, 1);

    // MaxNodesPerRead from Server.ServerCapabilities.OperationLimits
    // VariableIds.ServerType_ServerCapabilities_OperationLimits_MaxNodesPerRead
    self.maxNodesPerRead = 0;

    //  MaxNodesPerBrowse from Server.ServerCapabilities.OperationLimits
    //  VariableIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerBrowse
    self.maxNodesPerBrowse = 0; // 0 = no limits

    // statistics
    self.startTime = new Date();
    self.readCounter = 0;
    self.browseCounter = 0;
    self.transactionCounter = 0;
}

util.inherits(NodeCrawler, EventEmitter);

NodeCrawler.prototype._initialize_referenceTypeId = function () {

    const self = this;

    function append_prepopulated_reference(browseName) {

        const nodeId = makeNodeId(ReferenceTypeIds[browseName], 0);
        assert(nodeId);
        const cacheNode = self._createCacheNode(nodeId);
        cacheNode.browseName = new QualifiedName({name: browseName});
    }

    //  References
    //  +->(hasSubtype) NoHierarchicalReferences
    //                  +->(hasSubtype) HasTypeDefinition
    //  +->(hasSubtype) HierarchicalReferences
    //                  +->(hasSubtype) HasChild/ChildOf
    //                                  +->(hasSubtype) Aggregates/AggregatedBy
    //                                                  +-> HasProperty/PropertyOf
    //                                                  +-> HasComponent/ComponentOf
    //                                                  +-> HasHistoricalConfiguration/HistoricalConfigurationOf
    //                                 +->(hasSubtype) HasSubtype/HasSupertype
    //                  +->(hasSubtype) Organizes/OrganizedBy
    //                  +->(hasSubtype) HasEventSource/EventSourceOf
    append_prepopulated_reference("HasTypeDefinition");
    append_prepopulated_reference("HasChild");
    append_prepopulated_reference("HasProperty");
    append_prepopulated_reference("HasComponent");
    append_prepopulated_reference("HasHistoricalConfiguration");
    append_prepopulated_reference("HasSubtype");
    append_prepopulated_reference("Organizes");
    append_prepopulated_reference("HasEventSource");

};

NodeCrawler.prototype._readOperationalLimits = function (callback) {

    const self = this;
    const n1 = makeNodeId(VariableIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerRead);
    const n2 = makeNodeId(VariableIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerBrowse);
    const nodesToRead = [
        {nodeId: n1, attributeId: AttributeIds.Value},
        {nodeId: n2, attributeId: AttributeIds.Value}
    ];
    self.transactionCounter++;
    self.session.read(nodesToRead, function (err, dataValues) {
        if (!err) {
            if (dataValues[0].statusCode.equals(StatusCodes.Good)) {
                self.maxNodesPerRead = dataValues[0].value.value;
            }
            // ensure we have a sensible maxNodesPerRead value in case the server doesn't specify one
            self.maxNodesPerRead = self.maxNodesPerRead || 500;

            if (dataValues[1].statusCode.equals(StatusCodes.Good)) {
                self.maxNodesPerBrowse = dataValues[1].value.value;
            }
            // ensure we have a sensible maxNodesPerBrowse value in case the server doesn't specify one
            self.maxNodesPerBrowse = self.maxNodesPerBrowse || 500;

        }
        callback(err);
    });
};

function make_node_attribute_key(nodeId, attributeId) {
    const key = nodeId.toString() + "_" + attributeId.toString();
    return key;
}

NodeCrawler.prototype.set_cache_NodeAttribute = function (nodeId, attributeId, value) {
    const self = this;
    const key = make_node_attribute_key(nodeId, attributeId);
    self.browseNameMap[key] = value;
};

NodeCrawler.prototype.has_cache_NodeAttribute = function (nodeId, attributeId) {
    const self = this;
    const key = make_node_attribute_key(nodeId, attributeId);
    return self.browseNameMap.hasOwnProperty(key);
};

NodeCrawler.prototype.get_cache_NodeAttribute = function (nodeId, attributeId) {
    const self = this;
    const key = make_node_attribute_key(nodeId, attributeId);
    return self.browseNameMap[key];
};

/**
 * request a read operation for a Node+Attribute in the future, provides a callback
 *
 * @method _defer_readNode
 * @param nodeId {NodeId}
 * @param attributeId {AttributeId}
 * @param {function} callback
 * @param {Error|null} callback.err
 * @param {string} callback.dataValue
 * @private
 */



NodeCrawler.prototype._defer_readNode = function (nodeId, attributeId, callback) {
    const self = this;

    nodeId = resolveNodeId(nodeId);
    assert(nodeId instanceof NodeId);

    const key = make_node_attribute_key(nodeId, attributeId);

    if (self.has_cache_NodeAttribute(nodeId, attributeId)) {
        callback(null, self.get_cache_NodeAttribute(nodeId, attributeId));
    } else {
        self.browseNameMap[key] = "?";
        self._nodesToReadEx.push({
            nodeToRead: {
                nodeId: nodeId,
                attributeId: attributeId
            },
            action: function (dataValue) {
                self.set_cache_NodeAttribute(nodeId, attributeId, dataValue);
                callback(null, dataValue);
            }
        });
    }
};

/**
 * perform pending read Node operation
 * @method _resolve_deferred_readNode
 * @param callback {Function}
 * @private
 */
NodeCrawler.prototype._resolve_deferred_readNode = function (callback) {

    const self = this;
    if (self._nodesToReadEx.length === 0) {
        // nothing to read
        callback();
        return;
    }

    const _nodesToReadEx = _fetch_elements(self._nodesToReadEx, self.maxNodesPerRead);

    const nodesToRead = _nodesToReadEx.map(function (e) {
        return e.nodeToRead;
    });

    self.readCounter += nodesToRead.length;
    self.transactionCounter++;

    self.session.read(nodesToRead, function (err, dataValues /*, diagnostics*/) {

        if (!err) {

            for (const pair of _.zip(_nodesToReadEx, dataValues)) {
                const _nodeToReadEx = pair[0];

                const dataValue = pair[1];
                assert(dataValue.hasOwnProperty("statusCode"));
                if (dataValue.statusCode.equals(StatusCodes.Good)) {
                    if (dataValue.value === null) {
                        _nodeToReadEx.action(null);
                    }
                    else {
                        _nodeToReadEx.action(dataValue.value.value);
                    }
                } else {
                    _nodeToReadEx.action({name: dataValue.statusCode.key});
                }

            }
        }
        callback(err);
    });
};

NodeCrawler.prototype._resolve_deferred = function (comment, collection, method) {
    const self = this;

    if (collection.length > 0) {
        self._push_task("adding operation " + comment, {
            params: {},
            func: function (task, callback) {
                method.call(self, callback);
            }
        });
    }
};

NodeCrawler.prototype.resolve_deferred_readNode = function () {
    this._resolve_deferred("read_node", this._nodesToReadEx, this._resolve_deferred_readNode);
};

NodeCrawler.prototype.resolve_deferred_browseNode = function () {
    this._resolve_deferred("browse_node", this._objectToBrowse, this._resolve_deferred_browseNode);
};

const pendingBrowseName = new QualifiedName({name: "pending"});
function CacheNode(nodeId) {
    /**
     * @property nodeId
     * @type NodeId
     */
    this.nodeId = nodeId;
    /**
     * @property browseName
     * @type     QualifiedName
     */
    this.browseName = pendingBrowseName;
    /**
     * @property references
     * @type ReferenceDescription[]
     */
    this.references = [];
}

function w(s, l) {
    return (s + "                                                                ").substr(0, l);
}
CacheNode.prototype.toString = function () {
    let str = w(this.nodeId.toString(), 20);
    str += " " + w(this.browseName.toString(), 30);
    str += " typeDef : " + w((this.typeDefinition ? this.typeDefinition.toString() : ""), 30);
    str += " nodeClass : " + w((this.nodeClass ? this.nodeClass.toString() : ""), 12);
    return str;
};

NodeCrawler.prototype._getCacheNode = function (nodeId) {
    const self = this;
    const key = resolveNodeId(nodeId).toString();
    const cacheNode = self._objectCache[key];
    return cacheNode;
};

NodeCrawler.prototype._createCacheNode = function (nodeId) {
    const self = this;
    const key = resolveNodeId(nodeId).toString();
    let cacheNode = self._objectCache[key];
    if (cacheNode) {
        throw new Error("NodeCrawler#_createCacheNode : cache node should not exist already : " + nodeId.toString());
    }
    cacheNode = new CacheNode(nodeId);
    assert(!self._objectCache.hasOwnProperty(key));
    self._objectCache[key] = cacheNode;
    return cacheNode;
};

/**
 * perform a deferred browse
 * instead of calling session.browse directly, this function add the request to a list
 * so that request can be grouped and send in one single browse command to the server.
 *
 * @method _defer_browse_node
 * @private
 * @param cacheNode                {CacheNode}
 * @param referenceTypeId       {string|ReferenceType}
 * @param actionOnBrowse        {Function}
 * @param actionOnBrowse.err    {Error|null}
 * @param actionOnBrowse.object {CacheNode}
 *
 */
NodeCrawler.prototype._defer_browse_node = function (cacheNode, referenceTypeId, actionOnBrowse) {
    const self = this;
    self._objectToBrowse.push({
        cacheNode: cacheNode,
        nodeId: cacheNode.nodeId,
        referenceTypeId: referenceTypeId,
        action: function (object) {
            assert(object === cacheNode);
            assert(_.isArray(object.references));
            assert(cacheNode.browseName.name !== "pending");
            actionOnBrowse(null, cacheNode);
        }
    });
};

const referencesId = resolveNodeId("References");
const hierarchicalReferencesId = resolveNodeId("HierarchicalReferences");
const hasTypeDefinitionId = resolveNodeId("HasTypeDefinition");


function dedup_reference(references) {
    const results = [];
    const dedup = {};
    for (const reference of  references) {
        const key = reference.referenceTypeId.toString() + reference.nodeId.toString();
        if (dedup[key]) {
            console.log(" Warning => Duplicated reference found  !!!! please contact the server vendor");
            console.log(reference.toString());
            continue;
        }
        dedup[key] = reference;
        results.push(reference);
    }
    return results;
}
/**
 * @method _process_single_browseResult
 * @param _objectToBrowse
 * @param browseResult {BrowseResult}
 * @private
 */
NodeCrawler.prototype._process_single_browseResult = function (_objectToBrowse, browseResult) {

    const self = this;

    assert(browseResult.continuationPoint === null, "NodeCrawler doesn't support continuation point yet");

    const cacheNode = _objectToBrowse.cacheNode;

    // note : some OPCUA may expose duplicated reference, they need to be filtered out
    // dedup reference

    cacheNode.references = dedup_reference(browseResult.references);

    const tmp = browseResult.references.filter(function (x) {
        return sameNodeId(x.referenceTypeId, hasTypeDefinitionId);
    });
    if (tmp.length) {
        cacheNode.typeDefinition = tmp[0].nodeId;
    }

    async.parallel([

          function (callback) {
              if (cacheNode.browseName !== pendingBrowseName) {
                  return callback();
              }
              self._defer_readNode(cacheNode.nodeId, AttributeIds.BrowseName, function (err, browseName) {
                  cacheNode.browseName = browseName;
                  callback();
              });
          },
          function (callback) {
              if (cacheNode.displayName) {
                  return callback();
              }
              self._defer_readNode(cacheNode.nodeId, AttributeIds.DisplayName, function (err, value) {
                  if (err) {
                      return callback(err);
                  }
                  if (!(value instanceof LocalizedText)) {
                      console.log(cacheNode.toString())
                  }
                  assert(value instanceof LocalizedText);
                  cacheNode.displayName = value;
                  setImmediate(callback);
              });
          },
          function (callback) {
              // only if nodeClass is Variable
              if (cacheNode.nodeClass !== NodeClass.Variable) {
                  return callback();
              }
              // read dataType and DataType if node is a variable
              self._defer_readNode(cacheNode.nodeId, AttributeIds.DataType, function (err, dataType) {

                  if (!(dataType instanceof NodeId)) {
                      return callback();
                  }
                  cacheNode.dataType = dataType;
                  callback();
              });
          },
          function (callback) {
              if (cacheNode.nodeClass !== NodeClass.Variable) {
                  return callback();
              }
              self._defer_readNode(cacheNode.nodeId, AttributeIds.Value, function (err, value) {
                  cacheNode.dataValue = value;
                  callback();
              });
          },
          function (callback) {
              if (cacheNode.nodeClass !== NodeClass.Variable) {
                  return callback();
              }
              self._defer_readNode(cacheNode.nodeId, AttributeIds.MinimumSamplingInterval, function (err, value) {
                  cacheNode.minimumSamplingInterval = value;
                  callback();
              });
          },
          function (callback) {
              if (cacheNode.nodeClass !== NodeClass.Variable) {
                  return callback();
              }
              self._defer_readNode(cacheNode.nodeId, AttributeIds.AccessLevel, function (err, value) {
                  cacheNode.accessLevel = value;
                  callback();
              });
          },
          function (callback) {
              if (cacheNode.nodeClass !== NodeClass.Variable) {
                  return callback();
              }
              self._defer_readNode(cacheNode.nodeId, AttributeIds.UserAccessLevel, function (err, value) {
                  cacheNode.userAccessLevel = value;
                  callback();
              });
          }
      ], function (err) {
          if (err) {
              console.log("ERRROR".red, err);
          }
          _objectToBrowse.action(cacheNode);
      }
    );
};

NodeCrawler.prototype._process_browse_response = function (task, callback) {
    /* jshint validthis: true */
    const self = this;
    const objectsToBrowse = task.param.objectsToBrowse;
    const browseResults = task.param.browseResults;
    for (const pair of _.zip(objectsToBrowse, browseResults)) {
        const objectToBrowse = pair[0];
        const browseResult = pair[1];
        assert(browseResult instanceof browse_service.BrowseResult);
        self._process_single_browseResult(objectToBrowse, browseResult);
    }
    setImmediate(callback);
};

const makeResultMask = require("node-opcua-data-model").makeResultMask;

//                         "ReferenceType | IsForward | BrowseName | NodeClass | DisplayName | TypeDefinition"
const resultMask = makeResultMask("ReferenceType | IsForward | BrowseName | DisplayName | NodeClass | TypeDefinition");

NodeCrawler.prototype._resolve_deferred_browseNode = function (callback) {

    const self = this;

    if (self._objectToBrowse.length === 0) {
        callback();
        return;
    }

    const objectsToBrowse = _fetch_elements(self._objectToBrowse, self.maxNodesPerBrowse);

    const nodesToBrowse = objectsToBrowse.map(function (e) {
        assert(e.hasOwnProperty("referenceTypeId"));
        return new BrowseDescription({
            browseDirection: BrowseDirection.Forward,
            referenceTypeId: e.referenceTypeId,
            includeSubtypes: true,
            nodeId: e.nodeId,
            resultMask: resultMask
        });
    });

    self.browseCounter += nodesToBrowse.length;
    self.transactionCounter++;

    self.session.browse(nodesToBrowse, function (err, browseResults /*, diagnostics*/) {

        if (!err) {
            assert(browseResults.length === nodesToBrowse.length);
            self._unshift_task("process browseResults", {
                param: {
                    objectsToBrowse: objectsToBrowse,
                    browseResults: browseResults
                },
                func: NodeCrawler.prototype._process_browse_response
            });

        } else {
            console.log("ERROR = ", err);
        }
        callback(err);

    });
};

/**
 * @method _unshift_task
 * add a task on top of the queue (high priority)
 * @param name {string}
 * @param task
 * @private
 */
NodeCrawler.prototype._unshift_task = function (name, task) {
    const self = this;
    assert(_.isFunction(task.func));
    task.comment = "S:" + name;
    assert(task.func.length === 2);
    self.q.unshift(task);
};

/**
 * @method _push_task
 * add a task at the bottom of the queue (low priority)
 * @param name {string}
 * @param task
 * @private
 */
NodeCrawler.prototype._push_task = function (name, task) {
    const self = this;
    assert(_.isFunction(task.func));
    task.comment = "P:" + name;
    assert(task.func.length === 2);
    self.q.push(task);
};


NodeCrawler.follow = function (crawler, cacheNode, userData) {
    for (const reference of cacheNode.references) {
        crawler.followReference(cacheNode, reference, userData);
    }
};
/***
 * @method _emit_on_crawled
 * @param cacheNode
 * @param userData
 * @param [userData.onBrowsed=null] {Function}
 * @private
 */
NodeCrawler.prototype._emit_on_crawled = function (cacheNode, userData) {
    const self = this;
    self.emit("browsed", cacheNode, userData);
};


NodeCrawler.prototype._crawl_task = function (task, callback) {

    const self = this;

    const cacheNode = task.params.cacheNode;
    let nodeId = task.params.cacheNode.nodeId;

    nodeId = resolveNodeId(nodeId);
    const key = nodeId.toString();

    if (self._visited_node.hasOwnProperty(key)) {
        console.log("skipping already visited", key);
        callback();
        return;// already visited
    }
    // mark as visited to avoid infinite recursion
    self._visited_node[key] = true;

    function browse_node_action(err, cacheNode) {
        if (!err) {
            for (let i = 0; i < cacheNode.references.length; i++) {

                const reference = cacheNode.references[i];
                // those ones come for free
                if (!self.has_cache_NodeAttribute(reference.nodeId, AttributeIds.BrowseName)) {
                    self.set_cache_NodeAttribute(reference.nodeId, AttributeIds.BrowseName, reference.browseName);
                }
                if (!self.has_cache_NodeAttribute(reference.nodeId, AttributeIds.DisplayName)) {
                    self.set_cache_NodeAttribute(reference.nodeId, AttributeIds.DisplayName, reference.displayName);
                }
                if (!self.has_cache_NodeAttribute(reference.nodeId, AttributeIds.NodeClass)) {
                    self.set_cache_NodeAttribute(reference.nodeId, AttributeIds.NodeClass, reference.nodeClass);
                }
            }
            self._emit_on_crawled(cacheNode, task.params.userData);
            const userData = task.params.userData;
            if (userData.onBrowse) {
                userData.onBrowse(self, cacheNode, userData);
            }

        }
    }

    self._defer_browse_node(cacheNode, referencesId, browse_node_action);
    callback();
};

NodeCrawler.prototype._add_crawl_task = function (cacheNode, userData) {
    /* jshint validthis: true */
    const self = this;
    assert(cacheNode instanceof CacheNode);
    assert(userData);
    assert(_.isObject(self));
    assert(_.isObject(self._crawled));

    const key = cacheNode.nodeId.toString();
    if (self._crawled.hasOwnProperty(key)) {
        return;
    }
    self._crawled[key] = 1;

    self._push_task("_crawl task", {
        params: {
            cacheNode: cacheNode,
            userData: userData
        },
        func: NodeCrawler.prototype._crawl_task
    });
};

NodeCrawler.prototype._inner_crawl = function (nodeId, userData, end_callback) {

    const self = this;
    assert(_.isObject(userData));
    assert(_.isFunction(end_callback));
    assert(!self._visited_node);
    assert(!self._crawled);
    self._visited_node = {};
    self._crawled = {};

    let _has_ended = false;
    self.q.drain = function () {

        if (!_has_ended) {

            _has_ended = true;

            self._visited_node = null;
            self._crawled = null;

            self.emit("end");
            end_callback();
        }
    };


    let cacheNode = self._getCacheNode(nodeId);
    if (!cacheNode) {
        cacheNode = self._createCacheNode(nodeId);
    }

    assert(cacheNode.nodeId.toString() === nodeId.toString());

    // ----------------------- Read missing essential information about node
    // such as nodeClass, typeDefinition browseName, displayName
    // this sequence is only necessary on the top node being crawled,
    // as browseName,displayName,nodeClass will be provided by ReferenceDescription later on for child nodes
    //
    async.parallel([
        function (callback) {
            self._defer_readNode(cacheNode.nodeId, AttributeIds.BrowseName, function (err, value) {
                if (err) {
                    return callback(err);
                }
                assert(value instanceof QualifiedName);
                cacheNode.browseName = value;
                setImmediate(callback);
            });
        },
        function (callback) {
            self._defer_readNode(cacheNode.nodeId, AttributeIds.NodeClass, function (err, value) {
                if (err) {
                    return callback(err);
                }
                cacheNode.nodeClass = NodeClass.get(value);
                setImmediate(callback);
            });
        },
        function (callback) {
            self._defer_readNode(cacheNode.nodeId, AttributeIds.DisplayName, function (err, value) {
                if (err) {
                    return callback(err);
                }
                assert(value instanceof LocalizedText);
                cacheNode.displayName = value;
                setImmediate(callback);
            });
        },
        function (callback) {
            self._resolve_deferred_readNode(callback);
        }
    ], function (err) {
        self._add_crawl_task(cacheNode, userData);
    });


};

/**
 * @method crawl
 * @param nodeId {NodeId}
 * @param userData {Object}
 * @param userData.onBrowse           {Function}
 * @param userData.onBrowse.crawler   {NodeCrawler}
 * @param userData.onBrowse.cacheNode {CacheNode}
 * @param end_callback {Function}
 */
NodeCrawler.prototype.crawl = function (nodeId, userData, end_callback) {
    assert(_.isFunction(end_callback));
    const self = this;
    self._readOperationalLimits(function (err) {

        if (err) {
            return end_callback(err);
        }
        self._inner_crawl(nodeId, userData, end_callback);
    });
};


function _setExtraReference(task, callback) {
    const params = task.params;
    params.userData.setExtraReference(params.parentNode, params.reference, params.childCacheNode, params.userData);
    callback();
}

NodeCrawler.prototype.followReference = function (parentNode, reference, userData) {

    assert(reference instanceof browse_service.ReferenceDescription);

    const crawler = this;

    let childCacheNodeRef = crawler._getCacheNode(reference.referenceTypeId);
    if (!childCacheNodeRef) {
        childCacheNodeRef = crawler._createCacheNode(reference.referenceTypeId);
        crawler._add_crawl_task(childCacheNodeRef, userData);
    }

    let childCacheNode = crawler._getCacheNode(reference.nodeId);
    if (!childCacheNode) {
        childCacheNode = crawler._createCacheNode(reference.nodeId);
        childCacheNode.browseName = reference.browseName;
        childCacheNode.displayName = reference.DisplayName;
        childCacheNode.typeDefinition = reference.typeDefinition;
        childCacheNode.nodeClass = reference.nodeClass;

        //xx console.log("HERE !",childCacheNode.toString());
        crawler._add_crawl_task(childCacheNode, userData);
    } else {

        if (userData.setExtraReference) {

            crawler._push_task("setExtraRef", {
                params: {
                    parentNode: parentNode,
                    reference: reference,
                    childCacheNode: childCacheNode,
                    userData: userData
                },
                func: _setExtraReference
            });
        }
    }
};

NodeCrawler.prototype.dispose = function () {
    const self = this;
    self.session = null;
    self.browseNameMap = null;
    self._nodesToReadEx = null;
    self._objectCache = null;
    self._objectToBrowse = null;
    self._objMap = null;
    self.q = null;
};

//---------------------------------------------------------------------------------------

NodeCrawler.prototype.read = function (nodeId, callback) {

    const self = this;

    try {
        nodeId = resolveNodeId(nodeId);
    } catch (err) {
        callback(err);
    }

    function remove_cycle(object, callback) {


        const visitedNodeIds = {};

        function hasBeenVisited(e) {
            const key = e.nodeId.toString();
            return visitedNodeIds[key];
        }

        function setVisited(e) {
            const key = e.nodeId.toString();
            return visitedNodeIds[key] = e;
        }

        function mark_array(arr) {
            if (!arr) {
                return;
            }
            assert(_.isArray(arr));
            for (let index = 0; index < arr.length; index++) {
                const e = arr[index];
                if (hasBeenVisited(e)) {
                    return;
                } else {
                    setVisited(e);
                    explorerObject(e);
                }
            }
        }

        function explorerObject(obj) {
            mark_array(obj.organizes);
            mark_array(obj.hasComponent);
            mark_array(obj.hasNotifier);
            mark_array(obj.hasProperty);
        }


        explorerObject(object);
        callback(null, object);
    }

    function simplify_object(objMap, object, final_callback) {

        assert(_.isFunction(final_callback));

        const queue = async.queue(function (task, callback) {

            setImmediate(function () {
                assert(_.isFunction(task.func));
                task.func(task.data, callback);
            });
        }, 1);

        const key = object.nodeId.toString();

        function add_for_reconstruction(object, extra_func) {
            assert(_.isFunction(extra_func));
            assert(typeof object.nodeId.toString() === "string");
            queue.push({
                data: object,
                func: function (data, callback) {

                    _reconstruct_manageable_object(data, function (err, obj) {
                        extra_func(err, obj);
                        callback(err);
                    });
                }
            });
        }

        function _reconstruct_manageable_object(object, callback) {

            assert(_.isFunction(callback));
            assert(object);
            assert(object.nodeId);

            const key = object.nodeId.toString();

            if (objMap.hasOwnProperty(key)) {
                return callback(null, objMap[key]);
            }
            /* reconstruct a more manageable object
             * var obj = {
             *    browseName: "Objects",
             *    organises : [
             *       {
             *            browseName: "Server",
             *            hasComponent: [
             *            ]
             *            hasProperty: [
             *            ]
             *       }
             *    ]
             * }
             */
            const obj = {
                browseName: object.browseName.name,
                nodeId: object.nodeId.toString()
            };

            // Append nodeClass
            if (object.nodeClass) {
                obj.nodeClass = object.nodeClass.toString();
            }
            if (object.dataType) {
                obj.dataType = object.dataType.toString();
                obj.dataTypeName = object.dataTypeName;
                //xx  console.log("dataTypeObj",object.dataTypeObj.browseName);
            }
            if (object.dataValue) {
                if (object.dataValue instanceof Array || object.dataValue.length > 10) {
                    // too much verbosity here
                } else {
                    obj.dataValue = object.dataValue.toString();
                }
            }
            objMap[key] = obj;

            const referenceMap = obj;

            object.references = object.references || [];


            object.references.map(function (ref) {

                assert(ref);
                const ref_index = ref.referenceTypeId.toString();

                const referenceType = self._objectCache[ref_index];

                if (!referenceType) {
                    console.log(("Unknown reference type " + ref_index).red.bold);
                    console.log(util.inspect(object, {colorize: true, depth: 10}));
                }
                const reference = self._objectCache[ref.nodeId.toString()];
                if (!reference) {
                    console.log(ref.nodeId.toString(), "bn=", ref.browseName.toString(), "class =", ref.nodeClass.toString(), ref.typeDefinition.toString());
                    console.log("#_reconstruct_manageable_object: Cannot find reference", ref.nodeId.toString(), "in cache");
                }
                // Extract nodeClass so it can be appended
                reference.nodeClass = ref.$nodeClass;

                const refName = lowerFirstLetter(referenceType.browseName.name);

                if (refName === "hasTypeDefinition") {
                    obj.typeDefinition = reference.browseName.name;
                } else {
                    if (!referenceMap[refName]) {
                        referenceMap[refName] = [];
                    }
                    add_for_reconstruction(reference, function (err, mobject) {
                        if (!err) {
                            referenceMap[refName].push(mobject);
                        }
                    });
                }
            });
            callback(null, obj);

        }

        add_for_reconstruction(object, function () {
        });

        queue.drain = function () {
            const object = self._objMap[key];
            remove_cycle(object, callback);
        };
    }

    const key = nodeId.toString();

    // check if object has already been crawled
    if (self._objMap.hasOwnProperty(key)) {
        const object = self._objMap[key];
        return callback(null, object);
    }

    const userData = {
        onBrowse: NodeCrawler.follow
    };


    self.crawl(nodeId, userData, function () {

        if (self._objectCache.hasOwnProperty(key)) {

            const cacheNode = self._objectCache[key];
            assert(cacheNode.browseName.name !== "pending");

            simplify_object(self._objMap, cacheNode, callback);

        } else {
            callback(new Error("Cannot find nodeid" + key));
        }
    });
};


exports.NodeCrawler = NodeCrawler;