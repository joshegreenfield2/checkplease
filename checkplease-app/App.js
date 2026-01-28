import 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState, useCallback, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  RefreshControl,
  SafeAreaView,
  Modal,
  TextInput,
  Alert,
  Animated,
  BackHandler,
} from 'react-native';
import {
  GestureHandlerRootView,
  Swipeable,
  TouchableOpacity,
  ScrollView,
  FlatList,
} from 'react-native-gesture-handler';
import * as Contacts from 'expo-contacts';
import * as SMS from 'expo-sms';
import { supabase } from './supabase';
import Auth from './Auth';

const API_URL = 'https://checkplease-production.up.railway.app';

export default function App() {
  const [session, setSession] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  // Multi-select mode
  const [selectedTransactionIds, setSelectedTransactionIds] = useState([]);
  const [isSelectMode, setIsSelectMode] = useState(false);

  // Split editor state
  const [editingTransactions, setEditingTransactions] = useState([]);
  const [showSplitEditor, setShowSplitEditor] = useState(false);
  const [splitEditorView, setSplitEditorView] = useState('split'); // 'split' | 'contactSearch'
  const [sendMode, setSendMode] = useState('individual'); // 'individual' | 'group'
  const [contacts, setContacts] = useState([]);
  const [selectedContacts, setSelectedContacts] = useState([]);
  const [splitAmounts, setSplitAmounts] = useState({});
  const [lockedAmounts, setLockedAmounts] = useState({}); // { contactId: true }
  const [includeMe, setIncludeMe] = useState(true); // Whether "You" is included in split
  const [searchQuery, setSearchQuery] = useState('');

  // Recent contacts (most recently used)
  const [recentContacts, setRecentContacts] = useState([]);

  // Contacts removed during current session (for easy re-adding)
  const [removedContacts, setRemovedContacts] = useState([]);

  // Store splits: { transactionId: { contacts, amounts, requested } }
  const [splits, setSplits] = useState({});

  // Amount editing state to prevent glitching
  const [focusedInputId, setFocusedInputId] = useState(null);
  const [editingValue, setEditingValue] = useState('');
  const [selection, setSelection] = useState(null);

  // Track which grouped cards are expanded
  const [expandedGroups, setExpandedGroups] = useState({});

  // Track deleted transaction IDs (so they don't come back from server)
  const deletedIdsRef = useRef([]);

  const swipeableRefs = useRef({});

  const fetchTransactions = async () => {
    if (!session?.access_token) return;
    try {
      const response = await fetch(`${API_URL}/transactions`, {
        headers: {
          'ngrok-skip-browser-warning': 'true',
          'Authorization': `Bearer ${session.access_token}`,
        },
      });
      const data = await response.json();
      // Filter out locally deleted transactions using ref (not stale closure)
      const filtered = data.filter(t => !deletedIdsRef.current.includes(t.id));
      setTransactions(filtered);
      setError(null);
    } catch (err) {
      setError('Failed to connect to server');
    }
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
  }, []);

  useEffect(() => {
    if (!session) return;
    fetchTransactions();
    const interval = setInterval(fetchTransactions, 5000);
    return () => clearInterval(interval);
  }, [session]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchTransactions();
    setRefreshing(false);
  }, []);

  const loadContacts = async (forceReload = false) => {
    if (contacts.length > 0 && !forceReload) return;
    try {
      const { status } = await Contacts.requestPermissionsAsync();
      if (status === 'granted') {
        const { data } = await Contacts.getContactsAsync({
          fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
        });
        // Include all contacts with names
        const validContacts = data.filter(c => c.name);
        validContacts.sort((a, b) => a.name.localeCompare(b.name));
        setContacts(validContacts);
      } else {
        Alert.alert('Permission Required', 'Please allow access to contacts in Settings');
      }
    } catch (err) {
      console.log('Error loading contacts:', err);
      Alert.alert('Error', 'Could not load contacts');
    }
  };

  // Toggle transaction selection
  const toggleTransactionSelect = (id) => {
    setSelectedTransactionIds(prev => {
      if (prev.includes(id)) {
        const newIds = prev.filter(i => i !== id);
        if (newIds.length === 0) setIsSelectMode(false);
        return newIds;
      }
      return [...prev, id];
    });
  };

  // Start select mode with first transaction
  const startSelectMode = (id) => {
    setIsSelectMode(true);
    setSelectedTransactionIds([id]);
  };

  // Open split editor for selected transactions
  const openSplitEditor = async (transactionIds) => {
    await loadContacts();
    const txns = transactions.filter(t => transactionIds.includes(t.id));
    setEditingTransactions(txns);

    // Check if any have existing splits
    const existingSplit = splits[transactionIds[0]];
    if (existingSplit?.contacts) {
      setSelectedContacts(existingSplit.contacts);
      // Recalculate amounts for new totals including "me"
      const total = txns.reduce((sum, t) => sum + t.amount, 0);
      const evenAmount = total / (existingSplit.contacts.length + 1);
      const amounts = { 'me': parseFloat(evenAmount.toFixed(2)) };
      existingSplit.contacts.forEach(c => {
        amounts[c.id] = parseFloat(evenAmount.toFixed(2));
      });
      setSplitAmounts(amounts);
    } else {
      // No existing split - start with just "me" having the full amount
      setSelectedContacts([]);
      const total = txns.reduce((sum, t) => sum + t.amount, 0);
      setSplitAmounts({ 'me': parseFloat(total.toFixed(2)) });
    }
    setLockedAmounts({});
    setIncludeMe(true);
    setRemovedContacts([]);

    setShowSplitEditor(true);
    setIsSelectMode(false);
    setSelectedTransactionIds([]);
  };

  // Copy last group to selected transactions
  const copyLastGroupToSelected = () => {
    if (recentContacts.length === 0) {
      Alert.alert('No Recent Group', 'Make a split first to create a group');
      return;
    }
    openSplitEditorWithContacts(selectedTransactionIds, recentContacts);
  };

  const openSplitEditorWithContacts = async (transactionIds, contactsToUse) => {
    await loadContacts();
    const txns = transactions.filter(t => transactionIds.includes(t.id));
    setEditingTransactions(txns);
    setSelectedContacts(contactsToUse);

    // Calculate even split including "me"
    const total = txns.reduce((sum, t) => sum + t.amount, 0);
    const evenAmount = total / (contactsToUse.length + 1);
    const amounts = { 'me': parseFloat(evenAmount.toFixed(2)) };
    contactsToUse.forEach(c => {
      amounts[c.id] = parseFloat(evenAmount.toFixed(2));
    });
    setSplitAmounts(amounts);
    setLockedAmounts({});
    setIncludeMe(true);
    setRemovedContacts([]);

    setShowSplitEditor(true);
    setIsSelectMode(false);
    setSelectedTransactionIds([]);
  };

  // Open contact search
  const openContactSearch = () => {
    setSearchQuery('');
    setSplitEditorView('contactSearch');
    loadContacts();
  };

  // Add contact to split
  const addContactToSplit = (contact) => {
    if (selectedContacts.some(c => c.id === contact.id)) return;

    const newContacts = [...selectedContacts, contact];
    setSelectedContacts(newContacts);

    // Recalculate split - respect locked amounts
    const total = editingTransactions.reduce((sum, t) => sum + t.amount, 0);
    const allPeopleIds = includeMe ? ['me', ...newContacts.map(c => c.id)] : newContacts.map(c => c.id);
    const lockedTotal = allPeopleIds
      .filter(id => lockedAmounts[id])
      .reduce((sum, id) => sum + (splitAmounts[id] || 0), 0);
    const unlockedPeople = allPeopleIds.filter(id => !lockedAmounts[id]);
    const remainingAmount = total - lockedTotal;
    const evenAmount = unlockedPeople.length > 0 ? remainingAmount / unlockedPeople.length : 0;

    const amounts = {};
    allPeopleIds.forEach(id => {
      if (lockedAmounts[id]) {
        amounts[id] = splitAmounts[id] || 0;
      } else {
        amounts[id] = parseFloat(evenAmount.toFixed(2));
      }
    });
    setSplitAmounts(amounts);
    setSplitEditorView('split');
    setSearchQuery('');
  };

  // Close split editor and reset view state
  const closeSplitEditor = () => {
    setShowSplitEditor(false);
    setSplitEditorView('split');
    setSearchQuery('');
    setSendMode('individual');
    setLockedAmounts({});
    setIncludeMe(true);
  };

  // Handle Android back button
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (showSplitEditor && splitEditorView === 'contactSearch') {
        setSplitEditorView('split');
        setSearchQuery('');
        return true;
      }
      return false;
    });
    return () => backHandler.remove();
  }, [showSplitEditor, splitEditorView]);

  // Remove contact from split
  const removeContactFromSplit = (contactId) => {
    // Track the removed contact for easy re-adding
    const removedContact = selectedContacts.find(c => c.id === contactId);
    if (removedContact && !removedContacts.some(c => c.id === contactId)) {
      setRemovedContacts(prev => [...prev, removedContact]);
    }

    const newContacts = selectedContacts.filter(c => c.id !== contactId);
    setSelectedContacts(newContacts);

    // Remove lock for this contact
    setLockedAmounts(prev => {
      const updated = { ...prev };
      delete updated[contactId];
      return updated;
    });

    const total = editingTransactions.reduce((sum, t) => sum + t.amount, 0);
    const allPeopleIds = includeMe ? ['me', ...newContacts.map(c => c.id)] : newContacts.map(c => c.id);

    if (allPeopleIds.length > 0) {
      const lockedTotal = allPeopleIds
        .filter(id => lockedAmounts[id])
        .reduce((sum, id) => sum + (splitAmounts[id] || 0), 0);
      const unlockedPeople = allPeopleIds.filter(id => !lockedAmounts[id]);
      const remainingAmount = total - lockedTotal;
      const evenAmount = unlockedPeople.length > 0 ? remainingAmount / unlockedPeople.length : 0;

      const amounts = {};
      allPeopleIds.forEach(id => {
        if (lockedAmounts[id]) {
          amounts[id] = splitAmounts[id] || 0;
        } else {
          amounts[id] = parseFloat(evenAmount.toFixed(2));
        }
      });
      setSplitAmounts(amounts);
    } else {
      setSplitAmounts({});
    }
  };

  // Adjust amount for a contact (respects locks)
  const adjustAmount = (contactId, delta) => {
    setSplitAmounts(prev => {
      const currentAmount = prev[contactId] || 0;
      const newAmount = Math.max(0, currentAmount + delta);
      const difference = newAmount - currentAmount;

      // Get all people IDs conditionally including "me"
      const allPeopleIds = includeMe ? ['me', ...selectedContacts.map(c => c.id)] : selectedContacts.map(c => c.id);
      // Get unlocked people excluding the one being adjusted
      const unlockedOthers = allPeopleIds.filter(id => id !== contactId && !lockedAmounts[id]);
      const perPersonAdjust = unlockedOthers.length > 0 ? difference / unlockedOthers.length : 0;

      const newAmounts = { ...prev, [contactId]: parseFloat(newAmount.toFixed(2)) };
      unlockedOthers.forEach(id => {
        const adjusted = Math.max(0, (prev[id] || 0) - perPersonAdjust);
        newAmounts[id] = parseFloat(adjusted.toFixed(2));
      });
      return newAmounts;
    });
  };

  // Set amount directly for a contact (respects locks when redistributing)
  const setAmountDirectly = (contactId, value) => {
    const numValue = parseFloat(value.replace(/[^0-9.]/g, '')) || 0;
    const total = editingTransactions.reduce((sum, t) => sum + t.amount, 0);
    const clampedValue = Math.min(Math.max(0, numValue), total);

    setSplitAmounts(prev => {
      const currentAmount = prev[contactId] || 0;
      const difference = clampedValue - currentAmount;

      // Get all people IDs conditionally including "me"
      const allPeopleIds = includeMe ? ['me', ...selectedContacts.map(c => c.id)] : selectedContacts.map(c => c.id);
      // Get unlocked people excluding the one being adjusted
      const unlockedOthers = allPeopleIds.filter(id => id !== contactId && !lockedAmounts[id]);
      const perPersonAdjust = unlockedOthers.length > 0 ? difference / unlockedOthers.length : 0;

      const newAmounts = { ...prev, [contactId]: parseFloat(clampedValue.toFixed(2)) };
      unlockedOthers.forEach(id => {
        const adjusted = Math.max(0, (prev[id] || 0) - perPersonAdjust);
        newAmounts[id] = parseFloat(adjusted.toFixed(2));
      });
      return newAmounts;
    });
  };

  const getMyShare = () => {
    return splitAmounts['me'] || 0;
  };

  // Reset all amounts to even split
  const resetToEven = () => {
    const total = editingTransactions.reduce((sum, t) => sum + t.amount, 0);
    const allPeople = includeMe ? ['me', ...selectedContacts.map(c => c.id)] : selectedContacts.map(c => c.id);
    const evenAmount = allPeople.length > 0 ? total / allPeople.length : 0;

    const newAmounts = {};
    allPeople.forEach(id => {
      newAmounts[id] = parseFloat(evenAmount.toFixed(2));
    });
    setSplitAmounts(newAmounts);
    setLockedAmounts({}); // Clear all locks
  };

  // Exclude yourself from the split
  const excludeMe = () => {
    setIncludeMe(false);
    // Remove lock for 'me'
    setLockedAmounts(prev => {
      const updated = { ...prev };
      delete updated['me'];
      return updated;
    });
    // Redistribute amounts among contacts only
    const total = editingTransactions.reduce((sum, t) => sum + t.amount, 0);
    if (selectedContacts.length > 0) {
      const evenAmount = total / selectedContacts.length;
      const amounts = {};
      selectedContacts.forEach(c => {
        amounts[c.id] = parseFloat(evenAmount.toFixed(2));
      });
      setSplitAmounts(amounts);
    } else {
      setSplitAmounts({});
    }
  };

  // Add yourself back to the split
  const addMeBack = () => {
    setIncludeMe(true);
    // Redistribute amounts evenly including "me"
    const total = editingTransactions.reduce((sum, t) => sum + t.amount, 0);
    const allPeople = ['me', ...selectedContacts.map(c => c.id)];
    const evenAmount = total / allPeople.length;
    const amounts = {};
    allPeople.forEach(id => {
      amounts[id] = parseFloat(evenAmount.toFixed(2));
    });
    setSplitAmounts(amounts);
  };

  // Toggle lock for a person
  const toggleLock = (id) => {
    setLockedAmounts(prev => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  // Save split and update recent contacts
  const saveSplit = () => {
    if (selectedContacts.length === 0) {
      Alert.alert('Add People', 'Please add at least one person to split with');
      return;
    }

    // Save split for each transaction
    const newSplits = { ...splits };
    editingTransactions.forEach(txn => {
      // Calculate proportional amounts for this transaction
      const totalAmount = editingTransactions.reduce((sum, t) => sum + t.amount, 0);
      const ratio = txn.amount / totalAmount;
      const txnAmounts = {};
      selectedContacts.forEach(c => {
        txnAmounts[c.id] = parseFloat((splitAmounts[c.id] * ratio).toFixed(2));
      });

      newSplits[txn.id] = {
        contacts: selectedContacts,
        amounts: txnAmounts,
        requested: false,
      };
    });
    setSplits(newSplits);

    // Update recent contacts
    setRecentContacts(selectedContacts);

    closeSplitEditor();
    setEditingTransactions([]);
  };

  // Send payment requests
  const sendPaymentRequests = async () => {
    const isAvailable = await SMS.isAvailableAsync();
    if (!isAvailable) {
      Alert.alert('SMS Not Available', 'Cannot send text messages on this device');
      return;
    }

    // Group amounts by contact across all editing transactions
    const contactTotals = {};
    editingTransactions.forEach(txn => {
      const totalAmount = editingTransactions.reduce((sum, t) => sum + t.amount, 0);
      const ratio = txn.amount / totalAmount;
      selectedContacts.forEach(c => {
        if (!contactTotals[c.id]) {
          contactTotals[c.id] = { contact: c, amount: 0, merchants: [] };
        }
        contactTotals[c.id].amount += splitAmounts[c.id] * ratio;
        contactTotals[c.id].merchants.push(txn.merchant);
      });
    });

    if (sendMode === 'group') {
      // Send one group message to all contacts
      const phoneNumbers = selectedContacts
        .filter(c => c.phoneNumbers?.[0]?.number)
        .map(c => c.phoneNumbers[0].number);

      const merchantList = [...new Set(editingTransactions.map(t => t.merchant))].join(', ');
      const totalAmount = editingTransactions.reduce((sum, t) => sum + t.amount, 0);

      // Build breakdown message
      let breakdownLines = selectedContacts.map(c => {
        const amount = contactTotals[c.id]?.amount || 0;
        return `${c.name.split(' ')[0]}: $${amount.toFixed(2)}`;
      });

      const message = `Hey everyone! Here's the breakdown for ${merchantList} (total: $${totalAmount.toFixed(2)}):\n\n${breakdownLines.join('\n')}\n\nVenmo or Zelle me when you can!`;
      await SMS.sendSMSAsync(phoneNumbers, message);
    } else {
      // Send one message per contact
      for (const { contact, amount, merchants } of Object.values(contactTotals)) {
        const phone = contact.phoneNumbers?.[0]?.number;
        if (!phone) continue;
        const merchantList = [...new Set(merchants)].join(', ');
        const message = `Hey ${contact.name.split(' ')[0]}! You owe me $${amount.toFixed(2)} for ${merchantList}. Venmo or Zelle me when you can!`;
        await SMS.sendSMSAsync([phone], message);
      }
    }

    // Mark all as requested
    const newSplits = { ...splits };
    editingTransactions.forEach(txn => {
      if (newSplits[txn.id]) {
        newSplits[txn.id].requested = true;
      }
    });
    setSplits(newSplits);
    setRecentContacts(selectedContacts);

    closeSplitEditor();
    setEditingTransactions([]);
    Alert.alert('Sent!', 'Payment requests have been sent');
  };

  // Delete transactions
  const deleteTransactions = (ids) => {
    // Track deleted IDs using ref so they don't come back from server
    deletedIdsRef.current = [...deletedIdsRef.current, ...ids];
    setTransactions(prev => prev.filter(t => !ids.includes(t.id)));
    setSplits(prev => {
      const newSplits = { ...prev };
      ids.forEach(id => delete newSplits[id]);
      return newSplits;
    });
    setSelectedTransactionIds([]);
    setIsSelectMode(false);
  };

  const confirmDeleteSelected = () => {
    Alert.alert(
      'Delete Transactions',
      `Delete ${selectedTransactionIds.length} transaction(s)?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteTransactions(selectedTransactionIds) },
      ]
    );
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  };

  const formatAmount = (amount) => `$${parseFloat(amount).toFixed(2)}`;

  const getInitials = (name) => {
    const parts = name.split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.charAt(0).toUpperCase();
  };

  const filteredContacts = contacts.filter(c =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) &&
    !selectedContacts.some(sc => sc.id === c.id)
  );

  // Get contact set key for grouping (sorted contact IDs joined)
  const getContactSetKey = (transactionId) => {
    const split = splits[transactionId];
    if (!split?.contacts?.length) return null;
    return split.contacts.map(c => c.id).sort().join(',');
  };

  // Group transactions by their contact set
  const getGroupedTransactions = () => {
    const groups = [];
    const processedIds = new Set();

    transactions.forEach(txn => {
      if (processedIds.has(txn.id)) return;

      const contactKey = getContactSetKey(txn.id);

      if (!contactKey) {
        // No split - standalone transaction
        groups.push({
          id: txn.id,
          transactions: [txn],
          contacts: null,
          totalAmount: txn.amount,
          isRequested: false,
          isSingle: true,
        });
        processedIds.add(txn.id);
      } else {
        // Find all transactions with same contact set
        const matchingTxns = transactions.filter(t => {
          if (processedIds.has(t.id)) return false;
          return getContactSetKey(t.id) === contactKey;
        });

        const split = splits[txn.id];
        const allRequested = matchingTxns.every(t => splits[t.id]?.requested);

        groups.push({
          id: matchingTxns.map(t => t.id).join('-'),
          transactions: matchingTxns,
          contacts: split.contacts,
          totalAmount: matchingTxns.reduce((sum, t) => sum + t.amount, 0),
          isRequested: allRequested,
          isSingle: matchingTxns.length === 1,
        });

        matchingTxns.forEach(t => processedIds.add(t.id));
      }
    });

    return groups;
  };

  const toggleGroupExpanded = (groupId) => {
    setExpandedGroups(prev => ({
      ...prev,
      [groupId]: !prev[groupId],
    }));
  };

  // Render delete action for swipe
  const renderRightActions = (progress, dragX, transactionIds) => {
    const scale = dragX.interpolate({
      inputRange: [-100, 0],
      outputRange: [1, 0],
      extrapolate: 'clamp',
    });
    return (
      <TouchableOpacity
        style={styles.deleteAction}
        onPress={() => deleteTransactions(transactionIds)}
      >
        <Animated.Text style={[styles.deleteActionText, { transform: [{ scale }] }]}>
          Delete
        </Animated.Text>
      </TouchableOpacity>
    );
  };

  const renderGroup = ({ item: group }) => {
    const isExpanded = expandedGroups[group.id];
    const transactionIds = group.transactions.map(t => t.id);
    const anySelected = transactionIds.some(id => selectedTransactionIds.includes(id));
    const allSelected = transactionIds.every(id => selectedTransactionIds.includes(id));

    // For single transactions without splits, render simple card
    if (group.isSingle && !group.contacts) {
      const txn = group.transactions[0];
      const isSelected = selectedTransactionIds.includes(txn.id);

      return (
        <Swipeable
          ref={ref => swipeableRefs.current[txn.id] = ref}
          renderRightActions={(progress, dragX) => renderRightActions(progress, dragX, [txn.id])}
          friction={2}
        >
          <TouchableOpacity
            style={[
              styles.transactionCard,
              isSelected && styles.transactionCardSelected,
            ]}
            onPress={() => {
              if (isSelectMode) {
                toggleTransactionSelect(txn.id);
              } else {
                openSplitEditor([txn.id]);
              }
            }}
            onLongPress={() => startSelectMode(txn.id)}
            activeOpacity={0.7}
          >
            <View style={styles.transactionRow}>
              <TouchableOpacity
                style={[styles.checkbox, isSelected && styles.checkboxSelected]}
                onPress={() => {
                  if (!isSelectMode) startSelectMode(txn.id);
                  else toggleTransactionSelect(txn.id);
                }}
              >
                {isSelected && <Text style={styles.checkboxCheck}>✓</Text>}
              </TouchableOpacity>

              <View style={styles.transactionContent}>
                <View style={styles.transactionHeader}>
                  <Text style={styles.merchant} numberOfLines={1}>{txn.merchant}</Text>
                  <Text style={styles.amount}>{formatAmount(txn.amount)}</Text>
                </View>
                <Text style={styles.date}>{formatDate(txn.timestamp)}</Text>
              </View>
            </View>
          </TouchableOpacity>
        </Swipeable>
      );
    }

    // Grouped transaction card (with contacts)
    return (
      <Swipeable
        ref={ref => swipeableRefs.current[group.id] = ref}
        renderRightActions={(progress, dragX) => renderRightActions(progress, dragX, transactionIds)}
        friction={2}
      >
        <TouchableOpacity
          style={[
            styles.transactionCard,
            styles.groupedCard,
            group.isRequested && styles.transactionCardRequested,
            anySelected && styles.transactionCardSelected,
          ]}
          onPress={() => {
            if (isSelectMode) {
              // Toggle all transactions in group
              if (allSelected) {
                setSelectedTransactionIds(prev => {
                  const newIds = prev.filter(id => !transactionIds.includes(id));
                  if (newIds.length === 0) setIsSelectMode(false);
                  return newIds;
                });
              } else {
                setSelectedTransactionIds(prev => [...new Set([...prev, ...transactionIds])]);
              }
            } else {
              openSplitEditor(transactionIds);
            }
          }}
          onLongPress={() => {
            setIsSelectMode(true);
            setSelectedTransactionIds(transactionIds);
          }}
          activeOpacity={0.7}
        >
          <View style={styles.transactionRow}>
            <TouchableOpacity
              style={[styles.checkbox, allSelected && styles.checkboxSelected, anySelected && !allSelected && styles.checkboxPartial]}
              onPress={() => {
                if (!isSelectMode) {
                  setIsSelectMode(true);
                  setSelectedTransactionIds(transactionIds);
                } else if (allSelected) {
                  setSelectedTransactionIds(prev => {
                    const newIds = prev.filter(id => !transactionIds.includes(id));
                    if (newIds.length === 0) setIsSelectMode(false);
                    return newIds;
                  });
                } else {
                  setSelectedTransactionIds(prev => [...new Set([...prev, ...transactionIds])]);
                }
              }}
            >
              {allSelected && <Text style={styles.checkboxCheck}>✓</Text>}
              {anySelected && !allSelected && <Text style={styles.checkboxCheck}>−</Text>}
            </TouchableOpacity>

            <View style={styles.transactionContent}>
              <View style={styles.transactionHeader}>
                <View style={styles.groupHeader}>
                  {group.transactions.length > 1 ? (
                    <Text style={styles.merchant} numberOfLines={1}>
                      {group.transactions.length} purchases
                    </Text>
                  ) : (
                    <Text style={styles.merchant} numberOfLines={1}>
                      {group.transactions[0].merchant}
                    </Text>
                  )}
                  {group.transactions.length > 1 && (
                    <TouchableOpacity
                      onPress={() => toggleGroupExpanded(group.id)}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Text style={styles.expandArrow}>{isExpanded ? '▼' : '▶'}</Text>
                    </TouchableOpacity>
                  )}
                </View>
                <Text style={styles.amount}>{formatAmount(group.totalAmount)}</Text>
              </View>

              {/* Split info with contacts */}
              {group.contacts && (
                <View style={styles.splitInfo}>
                  <View style={styles.initialsRow}>
                    {group.contacts.slice(0, 4).map(c => (
                      <View key={c.id} style={styles.initialBubble}>
                        <Text style={styles.initialText}>{getInitials(c.name)}</Text>
                      </View>
                    ))}
                    {group.contacts.length > 4 && (
                      <Text style={styles.moreText}>+{group.contacts.length - 4}</Text>
                    )}
                  </View>
                  {group.isRequested && <Text style={styles.requestedBadge}>Sent</Text>}
                </View>
              )}

              {/* Expanded breakdown */}
              {isExpanded && group.transactions.length > 1 && (
                <View style={styles.breakdownContainer}>
                  {group.transactions.map(txn => (
                    <View key={txn.id} style={styles.breakdownRow}>
                      <Text style={styles.breakdownMerchant} numberOfLines={1}>{txn.merchant}</Text>
                      <Text style={styles.breakdownAmount}>{formatAmount(txn.amount)}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          </View>
        </TouchableOpacity>
      </Swipeable>
    );
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaView style={styles.container}>
        <StatusBar style="dark" />

        <View style={styles.header}>
          <Text style={styles.title}>Check Please</Text>
          {isSelectMode ? (
            <Text style={styles.subtitle}>{selectedTransactionIds.length} selected</Text>
          ) : (
            <Text style={styles.subtitle}>Tap to split · Swipe to delete</Text>
          )}
        </View>

        {/* Action bar when items selected */}
        {isSelectMode && (
          <View style={styles.actionBar}>
            <TouchableOpacity style={styles.actionButton} onPress={() => openSplitEditor(selectedTransactionIds)}>
              <Text style={styles.actionButtonText}>Split</Text>
            </TouchableOpacity>
            {recentContacts.length > 0 && (
              <TouchableOpacity style={styles.actionButton} onPress={copyLastGroupToSelected}>
                <Text style={styles.actionButtonText}>Use Last Group</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[styles.actionButton, styles.deleteButton]} onPress={confirmDeleteSelected}>
              <Text style={[styles.actionButtonText, styles.deleteButtonText]}>Delete</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelSelect} onPress={() => { setIsSelectMode(false); setSelectedTransactionIds([]); }}>
              <Text style={styles.cancelSelectText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}

        {error && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {transactions.length === 0 && !error ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No transactions yet</Text>
            <Text style={styles.emptySubtext}>Make a purchase and it will appear here</Text>
          </View>
        ) : (
          <FlatList
            data={getGroupedTransactions()}
            renderItem={renderGroup}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContainer}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            extraData={[splits, expandedGroups, selectedTransactionIds]}
          />
        )}

        {/* Split Editor Modal */}
        <Modal visible={showSplitEditor} animationType="slide" presentationStyle="pageSheet">
          <SafeAreaView style={styles.modalContainer}>
            {splitEditorView === 'split' ? (
              <>
                <View style={styles.modalHeader}>
                  <TouchableOpacity onPress={closeSplitEditor}>
                    <Text style={styles.cancelButton}>Cancel</Text>
                  </TouchableOpacity>
                  <Text style={styles.modalTitle}>Split Bill</Text>
                  <TouchableOpacity onPress={saveSplit}>
                    <Text style={styles.doneButton}>Save</Text>
                  </TouchableOpacity>
                </View>

                {/* Transaction summary */}
                <View style={styles.transactionSummary}>
                  {editingTransactions.length === 1 ? (
                    <Text style={styles.summaryMerchant}>{editingTransactions[0].merchant}</Text>
                  ) : (
                    <Text style={styles.summaryMerchant}>{editingTransactions.length} transactions</Text>
                  )}
                  <Text style={styles.summaryAmount}>
                    {formatAmount(editingTransactions.reduce((sum, t) => sum + t.amount, 0))}
                  </Text>

                  {/* Breakdown of transactions */}
                  {editingTransactions.length > 1 && (
                    <View style={styles.summaryBreakdown}>
                      {editingTransactions.map(txn => (
                        <View key={txn.id} style={styles.summaryBreakdownRow}>
                          <Text style={styles.summaryBreakdownMerchant} numberOfLines={1}>{txn.merchant}</Text>
                          <Text style={styles.summaryBreakdownAmount}>{formatAmount(txn.amount)}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  {/* Add Person button - prominent location */}
                  <TouchableOpacity
                    style={styles.addPersonButtonTop}
                    onPress={openContactSearch}
                    hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
                    activeOpacity={0.6}
                  >
                    <Text style={styles.addPersonButtonText}>+ Add Person</Text>
                  </TouchableOpacity>

                  {/* Split Evenly button */}
                  {selectedContacts.length > 0 && (
                    <TouchableOpacity
                      style={styles.resetEvenButton}
                      onPress={resetToEven}
                      activeOpacity={0.6}
                    >
                      <Text style={styles.resetEvenButtonText}>Split Evenly</Text>
                    </TouchableOpacity>
                  )}
                </View>

                <ScrollView style={styles.splitList} keyboardShouldPersistTaps="handled">
                  {/* Your share - tap avatar to exclude yourself */}
                  {includeMe && (
                    <View style={[styles.splitRow, lockedAmounts['me'] && styles.lockedRow]}>
                      <View style={styles.splitPerson}>
                        <View style={styles.avatarContainer}>
                          <View style={[styles.avatar, styles.youAvatar]}>
                            <Text style={styles.avatarText}>You</Text>
                          </View>
                          <View style={styles.removeBadgeContainer}>
                            <TouchableOpacity
                              onPress={excludeMe}
                              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            >
                              <View style={styles.removeBadge}>
                                <Text style={styles.removeBadgeText}>×</Text>
                              </View>
                            </TouchableOpacity>
                          </View>
                        </View>
                        <Text style={styles.splitName}>You</Text>
                      </View>
                      <View style={styles.amountControls}>
                        <TouchableOpacity style={styles.lockButton} onPress={() => toggleLock('me')}>
                          {lockedAmounts['me'] ? (
                            <View style={styles.lockButtonLocked}>
                              <Text style={styles.lockButtonText}>🔒</Text>
                            </View>
                          ) : (
                            <Text style={styles.lockButtonTextUnlocked}>🔓</Text>
                          )}
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.amountButton} onPress={() => adjustAmount('me', -1)}>
                          <Text style={styles.amountButtonText}>−</Text>
                        </TouchableOpacity>
                        <TextInput
                          style={styles.amountInput}
                          value={focusedInputId === 'me' ? editingValue : formatAmount(getMyShare())}
                          selection={focusedInputId === 'me' ? selection : undefined}
                          onFocus={() => {
                            const raw = getMyShare().toFixed(2);
                            setEditingValue(raw);
                            setFocusedInputId('me');
                            setSelection({ start: 0, end: raw.length });
                          }}
                          onBlur={() => {
                            setFocusedInputId(null);
                            setSelection(null);
                          }}
                          onChangeText={(text) => {
                            setSelection(null);
                            const cleaned = text.replace(/[^0-9.]/g, '');
                            setEditingValue(cleaned);
                            setAmountDirectly('me', cleaned);
                          }}
                          keyboardType="decimal-pad"
                          selectTextOnFocus={true}
                          returnKeyType="done"
                        />
                        <TouchableOpacity style={styles.amountButton} onPress={() => adjustAmount('me', 1)}>
                          <Text style={styles.amountButtonText}>+</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  )}

                  {/* Quick Add section - show when there are recent/removed contacts or when "me" is excluded */}
                  {(recentContacts.filter(c => !selectedContacts.some(sc => sc.id === c.id)).length > 0 ||
                    removedContacts.filter(c => !selectedContacts.some(sc => sc.id === c.id)).length > 0 ||
                    !includeMe) && (
                      <View style={styles.suggestSection}>
                        <Text style={styles.suggestTitle}>Quick Add</Text>
                        <View style={styles.suggestRow}>
                          {/* Add Yourself option when excluded */}
                          {!includeMe && (
                            <TouchableOpacity style={styles.suggestChip} onPress={addMeBack}>
                              <Text style={styles.suggestChipText}>+ You</Text>
                            </TouchableOpacity>
                          )}
                          {/* Show removed contacts first for easy re-adding */}
                          {removedContacts
                            .filter(c => !selectedContacts.some(sc => sc.id === c.id))
                            .map(c => (
                              <TouchableOpacity key={`removed-${c.id}`} style={styles.suggestChip} onPress={() => addContactToSplit(c)}>
                                <Text style={styles.suggestChipText}>+ {c.name.split(' ')[0]}</Text>
                              </TouchableOpacity>
                            ))}
                          {/* Then show recent contacts (excluding any already shown from removed) */}
                          {recentContacts
                            .filter(c => !selectedContacts.some(sc => sc.id === c.id) && !removedContacts.some(rc => rc.id === c.id))
                            .map(c => (
                              <TouchableOpacity key={c.id} style={styles.suggestChip} onPress={() => addContactToSplit(c)}>
                                <Text style={styles.suggestChipText}>+ {c.name.split(' ')[0]}</Text>
                              </TouchableOpacity>
                            ))}
                        </View>
                      </View>
                    )}

                  {/* Selected contacts with amounts */}
                  {selectedContacts.map(contact => (
                    <View key={contact.id} style={[styles.splitRow, lockedAmounts[contact.id] && styles.lockedRow]}>
                      <View style={styles.splitPerson}>
                        <View style={styles.avatarContainer}>
                          <View style={styles.avatar}>
                            <Text style={styles.avatarText}>{getInitials(contact.name)}</Text>
                          </View>
                          <View style={styles.removeBadgeContainer}>
                            <TouchableOpacity
                              onPress={() => removeContactFromSplit(contact.id)}
                              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            >
                              <View style={styles.removeBadge}>
                                <Text style={styles.removeBadgeText}>×</Text>
                              </View>
                            </TouchableOpacity>
                          </View>
                        </View>
                        <Text style={styles.splitName}>{contact.name}</Text>
                      </View>
                      <View style={styles.amountControls}>
                        <TouchableOpacity style={styles.lockButton} onPress={() => toggleLock(contact.id)}>
                          {lockedAmounts[contact.id] ? (
                            <View style={styles.lockButtonLocked}>
                              <Text style={styles.lockButtonText}>🔒</Text>
                            </View>
                          ) : (
                            <Text style={styles.lockButtonTextUnlocked}>🔓</Text>
                          )}
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.amountButton} onPress={() => adjustAmount(contact.id, -1)}>
                          <Text style={styles.amountButtonText}>−</Text>
                        </TouchableOpacity>
                        <TextInput
                          style={styles.amountInput}
                          value={focusedInputId === contact.id ? editingValue : formatAmount(splitAmounts[contact.id] || 0)}
                          selection={focusedInputId === contact.id ? selection : undefined}
                          onFocus={() => {
                            const raw = (splitAmounts[contact.id] || 0).toFixed(2);
                            setEditingValue(raw);
                            setFocusedInputId(contact.id);
                            setSelection({ start: 0, end: raw.length });
                          }}
                          onBlur={() => {
                            setFocusedInputId(null);
                            setSelection(null);
                          }}
                          onChangeText={(text) => {
                            setSelection(null);
                            const cleaned = text.replace(/[^0-9.]/g, '');
                            setEditingValue(cleaned);
                            setAmountDirectly(contact.id, cleaned);
                          }}
                          keyboardType="decimal-pad"
                          selectTextOnFocus={true}
                          returnKeyType="done"
                        />
                        <TouchableOpacity style={styles.amountButton} onPress={() => adjustAmount(contact.id, 1)}>
                          <Text style={styles.amountButtonText}>+</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ))}

                </ScrollView>

                <View style={styles.splitActions}>
                  {/* Send mode toggle */}
                  <View style={styles.sendModeContainer}>
                    <Text style={styles.sendModeLabel}>Send as</Text>
                    <View style={styles.sendModeToggle}>
                      <TouchableOpacity
                        style={[styles.sendModeOption, sendMode === 'individual' && styles.sendModeOptionActive]}
                        onPress={() => setSendMode('individual')}
                      >
                        <Text style={[styles.sendModeOptionText, sendMode === 'individual' && styles.sendModeOptionTextActive]}>Individual</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.sendModeOption, sendMode === 'group' && styles.sendModeOptionActive]}
                        onPress={() => setSendMode('group')}
                      >
                        <Text style={[styles.sendModeOptionText, sendMode === 'group' && styles.sendModeOptionTextActive]}>Group</Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                  <TouchableOpacity style={styles.sendButton} onPress={sendPaymentRequests}>
                    <Text style={styles.sendButtonText}>Send Payment Requests</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <>
                <View style={styles.modalHeader}>
                  <TouchableOpacity onPress={() => { setSplitEditorView('split'); setSearchQuery(''); }}>
                    <Text style={styles.cancelButton}>Back</Text>
                  </TouchableOpacity>
                  <Text style={styles.modalTitle}>Add Person</Text>
                  <View style={{ width: 50 }} />
                </View>

                <TextInput
                  style={styles.searchInput}
                  placeholder="Search contacts..."
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  autoCorrect={false}
                  autoFocus
                />

                <FlatList
                  data={filteredContacts}
                  keyExtractor={(item) => item.id}
                  renderItem={({ item }) => (
                    <TouchableOpacity style={styles.contactItem} onPress={() => addContactToSplit(item)}>
                      <View style={styles.avatar}>
                        <Text style={styles.avatarText}>{getInitials(item.name)}</Text>
                      </View>
                      <Text style={styles.contactName}>{item.name}</Text>
                    </TouchableOpacity>
                  )}
                  contentContainerStyle={styles.contactList}
                />
              </>
            )}
          </SafeAreaView>
        </Modal>
      </SafeAreaView>
      {/* Sign Out Button (Optional/Temporary) */}
      <TouchableOpacity
        style={styles.signOutButton}
        onPress={() => supabase.auth.signOut()}
      >
        <Text style={styles.signOutText}>Sign Out ({session.user.email})</Text>
      </TouchableOpacity>
    </GestureHandlerRootView>
  );

  // If no session, show Auth screen
  if (!session) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Auth />
      </GestureHandlerRootView>
    );
  }

  return MainApp;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header: { padding: 20, paddingTop: 10, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e0e0e0' },
  title: { fontSize: 28, fontWeight: 'bold', color: '#333' },
  subtitle: { fontSize: 14, color: '#666', marginTop: 4 },
  actionBar: { flexDirection: 'row', padding: 12, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e0e0e0', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  actionButton: { backgroundColor: '#007AFF', paddingVertical: 8, paddingHorizontal: 16, borderRadius: 20 },
  actionButtonText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  deleteButton: { backgroundColor: '#ff3b30' },
  deleteButtonText: { color: '#fff' },
  cancelSelect: { marginLeft: 'auto' },
  cancelSelectText: { color: '#666', fontSize: 14 },
  listContainer: { padding: 16 },
  transactionCard: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 2, elevation: 2 },
  transactionCardRequested: { backgroundColor: '#fffde7' },
  transactionCardSelected: { backgroundColor: '#e3f2fd', borderColor: '#007AFF', borderWidth: 2 },
  transactionRow: { flexDirection: 'row', alignItems: 'flex-start' },
  checkbox: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: '#ccc', marginRight: 12, marginTop: 2, justifyContent: 'center', alignItems: 'center' },
  checkboxSelected: { backgroundColor: '#007AFF', borderColor: '#007AFF' },
  checkboxCheck: { color: '#fff', fontWeight: 'bold', fontSize: 14 },
  transactionContent: { flex: 1 },
  transactionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  merchant: { fontSize: 16, fontWeight: '600', color: '#333', flex: 1, marginRight: 12 },
  amount: { fontSize: 17, fontWeight: 'bold', color: '#2e7d32' },
  date: { fontSize: 12, color: '#888', marginTop: 4 },
  splitInfo: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#f0f0f0' },
  initialsRow: { flexDirection: 'row', alignItems: 'center' },
  initialBubble: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#e0e0e0', justifyContent: 'center', alignItems: 'center', marginRight: -6, borderWidth: 2, borderColor: '#fff' },
  initialText: { fontSize: 10, fontWeight: '700', color: '#666' },
  moreText: { fontSize: 12, color: '#888', marginLeft: 10 },
  requestedBadge: { fontSize: 11, color: '#f9a825', fontWeight: '600', backgroundColor: '#fff8e1', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  deleteAction: { backgroundColor: '#ff3b30', justifyContent: 'center', alignItems: 'center', width: 80, borderRadius: 12, marginBottom: 10 },
  deleteActionText: { color: '#fff', fontWeight: '600' },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  emptyText: { fontSize: 18, fontWeight: '600', color: '#666' },
  emptySubtext: { fontSize: 14, color: '#999', marginTop: 8, textAlign: 'center' },
  errorContainer: { backgroundColor: '#ffebee', padding: 12, margin: 16, borderRadius: 8 },
  errorText: { color: '#c62828', textAlign: 'center' },
  modalContainer: { flex: 1, backgroundColor: '#fff' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#e0e0e0' },
  modalTitle: { fontSize: 17, fontWeight: '600' },
  cancelButton: { fontSize: 17, color: '#666' },
  doneButton: { fontSize: 17, color: '#007AFF', fontWeight: '600' },
  transactionSummary: { padding: 16, backgroundColor: '#f8f8f8', alignItems: 'center' },
  summaryMerchant: { fontSize: 16, fontWeight: '600', color: '#333' },
  summaryAmount: { fontSize: 28, fontWeight: 'bold', color: '#2e7d32', marginTop: 4 },
  addPersonButtonTop: { backgroundColor: '#007AFF', paddingVertical: 10, paddingHorizontal: 20, borderRadius: 20, marginTop: 12 },
  addPersonButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  splitList: { flex: 1, padding: 16 },
  splitRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  splitPerson: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#e0e0e0', justifyContent: 'center', alignItems: 'center' },
  avatarContainer: { marginRight: 12, position: 'relative' },
  removeBadgeContainer: {
    position: 'absolute',
    top: -4,
    left: -4,
    zIndex: 1,
  },
  removeBadge: {
    backgroundColor: '#ff3b30',
    width: 18,
    height: 18,
    borderRadius: 9,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#fff',
  },
  removeBadgeText: { color: '#fff', fontSize: 12, fontWeight: 'bold', lineHeight: 14 },
  youAvatar: { backgroundColor: '#4caf50' },
  avatarText: { fontSize: 14, fontWeight: '700', color: '#666' },
  splitName: { fontSize: 16, fontWeight: '500', color: '#333' },
  splitAmountFixed: { fontSize: 18, fontWeight: '600', color: '#333' },
  amountControls: { flexDirection: 'row', alignItems: 'center' },
  amountButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#f0f0f0', justifyContent: 'center', alignItems: 'center' },
  amountButtonText: { fontSize: 20, fontWeight: '600', color: '#333' },
  amountValue: { fontSize: 17, fontWeight: '600', width: 70, textAlign: 'center' },
  suggestSection: { marginVertical: 16 },
  suggestTitle: { fontSize: 13, fontWeight: '600', color: '#888', marginBottom: 10 },
  suggestRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  suggestChip: { backgroundColor: '#e3f2fd', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20 },
  suggestChipText: { color: '#1976d2', fontWeight: '500' },
  addContactButton: { paddingVertical: 16, alignItems: 'center' },
  addContactText: { color: '#007AFF', fontSize: 16, fontWeight: '600' },
  splitActions: { padding: 16, borderTopWidth: 1, borderTopColor: '#e0e0e0' },
  sendButton: { backgroundColor: '#007AFF', padding: 16, borderRadius: 12, alignItems: 'center' },
  sendButtonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  searchInput: { margin: 16, padding: 12, backgroundColor: '#f0f0f0', borderRadius: 10, fontSize: 16 },
  contactList: { paddingHorizontal: 16 },
  contactItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  contactName: { fontSize: 16, color: '#333' },
  // Grouped transaction styles
  groupedCard: { borderLeftWidth: 3, borderLeftColor: '#007AFF' },
  groupHeader: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 12 },
  expandArrow: { fontSize: 12, color: '#888', marginLeft: 8 },
  checkboxPartial: { backgroundColor: '#007AFF', borderColor: '#007AFF', opacity: 0.6 },
  breakdownContainer: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#e0e0e0' },
  breakdownRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  breakdownMerchant: { fontSize: 14, color: '#666', flex: 1, marginRight: 12 },
  breakdownAmount: { fontSize: 14, color: '#666', fontWeight: '500' },
  // Summary breakdown styles
  summaryBreakdown: { marginTop: 12, width: '100%', paddingHorizontal: 20 },
  summaryBreakdownRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  summaryBreakdownMerchant: { fontSize: 14, color: '#666', flex: 1, marginRight: 12 },
  summaryBreakdownAmount: { fontSize: 14, color: '#666', fontWeight: '500' },
  // Amount input styles
  amountInput: { fontSize: 17, fontWeight: '600', width: 80, textAlign: 'center', backgroundColor: '#f8f8f8', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 8, marginHorizontal: 4 },
  // Send mode toggle styles
  sendModeContainer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  sendModeLabel: { fontSize: 15, fontWeight: '500', color: '#333' },
  sendModeToggle: { flexDirection: 'row', backgroundColor: '#f0f0f0', borderRadius: 8, padding: 2 },
  sendModeOption: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 6 },
  sendModeOptionActive: { backgroundColor: '#007AFF' },
  sendModeOptionText: { fontSize: 14, fontWeight: '500', color: '#666' },
  sendModeOptionTextActive: { color: '#fff' },
  // Lock and reset styles
  lockedRow: { backgroundColor: '#f0f4f8' },
  lockButton: { width: 32, height: 32, justifyContent: 'center', alignItems: 'center', marginRight: 4 },
  lockButtonLocked: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#007AFF', justifyContent: 'center', alignItems: 'center' },
  lockButtonText: { fontSize: 12 },
  lockButtonTextUnlocked: { fontSize: 18, opacity: 0.35 },
  resetEvenButton: { backgroundColor: '#f0f0f0', paddingVertical: 8, paddingHorizontal: 16, borderRadius: 16, marginTop: 8 },
  resetEvenButtonText: { color: '#666', fontSize: 14, fontWeight: '500' },
  signOutButton: { margin: 20, padding: 15, backgroundColor: '#f0f0f0', borderRadius: 10, alignItems: 'center' },
  signOutText: { color: '#666', fontSize: 14, fontWeight: '500' },
});
