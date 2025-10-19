// Task Center JavaScript - УЛЬТИМАТИВНАЯ РАБОЧАЯ ВЕРСИЯ
const SUPABASE_URL = 'https://bpsmizhrzgfbjqfpqkcz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJwc21pemhyemdmYmpxZnBxa2N6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk5MTE4NzQsImV4cCI6MjA3NTQ4Nzg3NH0.qYrRbTTTcGc_IqEXATezuU4sbbol6ELV9HumPW6cvwU';

let tcCurrentUser = null;
let tcUserData = null;
let tcTaskData = null;

// Task configurations
const TC_TASK_CONFIG = {
    'deposit_50': { required_amount: 50, bonus_amount: 3, type: 'deposit' },
    'deposit_100': { required_amount: 100, bonus_amount: 10, type: 'deposit' },
    'deposit_300': { required_amount: 300, bonus_amount: 12, type: 'deposit' },
    'deposit_500': { required_amount: 500, bonus_amount: 20, type: 'deposit' },
    'active_ref_1': { required_count: 1, bonus_amount: 3, type: 'referral' },
    'active_ref_3': { required_count: 3, bonus_amount: 12, type: 'referral' },
    'active_ref_5': { required_count: 5, bonus_amount: 20, type: 'referral' },
    'active_ref_8': { required_count: 8, bonus_amount: 25, type: 'referral' },
    'active_ref_18': { required_count: 18, bonus_amount: 35, type: 'referral' }
};

document.addEventListener('DOMContentLoaded', async function() {
    console.log('🚀 Task Center Initializing...');
    
    try {
        if (window.translationManager) {
            await window.translationManager.init();
        }
        
        await tcCheckAuth();
        await tcLoadUserData();
        await tcInitializeTasks();
        await tcForceTaskCheck();
        
        // 🚨 УЛЬТИМАТИВНЫЙ ФИКС - ВЫЗЫВАЕМ ГАРАНТИРОВАННО
        await tcUltimateFix();
        
        await tcAutoCheckAndClaim();
        tcSetupEventListeners();
        
        console.log('✅ Task Center Ready!');
    } catch (error) {
        console.error('❌ Initialization error:', error);
    }
});

async function tcCheckAuth() {
    try {
        const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        const { data: { user }, error } = await supabase.auth.getUser();
        if (error || !user) {
            window.location.href = 'index.html';
            return;
        }
        tcCurrentUser = user;
        console.log('🔐 User authenticated:', tcCurrentUser.id);
    } catch (error) {
        console.error('Auth error:', error);
        window.location.href = 'index.html';
    }
}

async function tcLoadUserData() {
    try {
        const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        const { data, error } = await supabase
            .from('users')
            .select('balance, total_profit')
            .eq('id', tcCurrentUser.id)
            .single();

        if (error) throw error;

        tcUserData = data;
        document.getElementById('balance-display').textContent = (tcUserData.balance || 0).toFixed(2) + ' USDT';
        console.log('💰 User balance loaded:', tcUserData.balance);

    } catch (error) {
        console.error('Load user data error:', error);
    }
}

async function tcInitializeTasks() {
    try {
        const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        
        const { data: existingTasks, error: fetchError } = await supabase
            .from('task_center')
            .select('task_type')
            .eq('user_id', tcCurrentUser.id);

        if (fetchError) {
            console.error('Error fetching existing tasks:', fetchError);
            return;
        }

        const existingTaskTypes = existingTasks?.map(t => t.task_type) || [];
        console.log('📋 Existing tasks:', existingTaskTypes);

        for (const taskType in TC_TASK_CONFIG) {
            if (!existingTaskTypes.includes(taskType)) {
                const config = TC_TASK_CONFIG[taskType];
                const { error: insertError } = await supabase
                    .from('task_center')
                    .insert([
                        {
                            user_id: tcCurrentUser.id,
                            task_type: taskType,
                            required_amount: config.required_amount || 0,
                            bonus_amount: config.bonus_amount,
                            required_count: config.required_count || 1,
                            current_count: 0,
                            claimed: false,
                            created_at: new Date().toISOString(),
                            updated_at: new Date().toISOString()
                        }
                    ]);

                if (insertError) {
                    console.error(`❌ Error creating task ${taskType}:`, insertError);
                } else {
                    console.log(`✅ Created new task: ${taskType}`);
                }
            }
        }
    } catch (error) {
        console.error('❌ Task initialization error:', error);
    }
}

async function tcLoadTaskProgress() {
    try {
        const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        
        const { data: tasks, error } = await supabase
            .from('task_center')
            .select('*')
            .eq('user_id', tcCurrentUser.id);

        if (error) throw error;

        tcTaskData = tasks;
        console.log('📊 Loaded task data:', tasks);
        tcUpdateTaskUI();

    } catch (error) {
        console.error('❌ Load task progress error:', error);
    }
}

async function tcForceTaskCheck() {
    console.log('🔄 Forcing task check...');
    await tcUpdateAllTaskCounters();
    await tcLoadTaskProgress();
}

async function tcUpdateAllTaskCounters() {
    try {
        const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        
        // Получаем рефералов 1 уровня
        const { data: level1Referrals, error: refError } = await supabase
            .from('referrals')
            .select('referred_id')
            .eq('referrer_id', tcCurrentUser.id)
            .eq('level', 1);

        if (refError) {
            console.error('❌ Error getting referrals:', refError);
            return;
        }

        if (!level1Referrals || level1Referrals.length === 0) {
            console.log('ℹ️ No level 1 referrals found');
            return;
        }

        const referredIds = level1Referrals.map(r => r.referred_id);
        console.log('👥 Referral IDs:', referredIds);

        // ОБНОВЛЯЕМ ЗАДАЧИ ПО ДЕПОЗИТАМ РЕФЕРАЛОВ
        for (const task of tcTaskData.filter(t => t.task_type.startsWith('deposit'))) {
            try {
                console.log(`🔍 Checking task ${task.task_type} with required amount: ${task.required_amount}`);
                
                const { data: referralDeposits, error: depositError } = await supabase
                    .from('deposits')
                    .select('user_id, amount, txid')
                    .in('user_id', referredIds)
                    .gte('amount', task.required_amount)
                    .eq('status', 'confirmed');

                if (depositError) {
                    console.error(`❌ Deposit query error for task ${task.task_type}:`, depositError);
                    continue;
                }

                console.log(`📈 Found ${referralDeposits?.length || 0} deposits for task ${task.task_type}`);

                const uniqueReferrals = new Set();
                referralDeposits?.forEach(deposit => {
                    uniqueReferrals.add(deposit.user_id);
                });

                const uniqueCount = uniqueReferrals.size;
                console.log(`🎯 Unique referrals with deposits ≥${task.required_amount}: ${uniqueCount}`);

                const { error: updateError } = await supabase
                    .from('task_center')
                    .update({ 
                        current_count: uniqueCount,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', task.id);

                if (updateError) {
                    console.error(`❌ Update error for task ${task.id}:`, updateError);
                } else {
                    console.log(`✅ Updated task ${task.task_type} count to ${uniqueCount}`);
                }

            } catch (taskError) {
                console.error(`❌ Error processing task ${task.task_type}:`, taskError);
            }
        }

        // ОБНОВЛЯЕМ ЗАДАЧИ ПО АКТИВНЫМ РЕФЕРАЛАМ
        for (const task of tcTaskData.filter(t => t.task_type.startsWith('active_ref'))) {
            try {
                console.log(`🔍 Checking active_ref task: ${task.task_type}`);
                
                const { data: activeReferrals, error: activeError } = await supabase
                    .from('users')
                    .select('id, balance')
                    .in('id', referredIds)
                    .gte('balance', 30);

                if (activeError) {
                    console.error(`❌ Active referrals error for task ${task.task_type}:`, activeError);
                    continue;
                }

                const activeReferralIds = activeReferrals?.map(user => user.id) || [];
                
                if (activeReferralIds.length > 0) {
                    const { data: referralDeposits, error: depositCheckError } = await supabase
                        .from('deposits')
                        .select('user_id, txid')
                        .in('user_id', activeReferralIds)
                        .gte('amount', 30)
                        .eq('status', 'confirmed');

                    if (!depositCheckError && referralDeposits) {
                        const depositedReferrals = new Set();
                        referralDeposits.forEach(deposit => {
                            depositedReferrals.add(deposit.user_id);
                        });
                        
                        const activeCount = depositedReferrals.size;
                        console.log(`👤 Active referrals with deposits ≥30: ${activeCount} for task ${task.task_type}`);

                        const { error: updateError } = await supabase
                            .from('task_center')
                            .update({ 
                                current_count: activeCount,
                                updated_at: new Date().toISOString()
                            })
                            .eq('id', task.id);

                        if (!updateError) {
                            console.log(`✅ Updated active_ref task ${task.task_type} count to ${activeCount}`);
                        }
                    } else {
                        console.log(`ℹ️ No confirmed deposits found for active referrals in task ${task.task_type}`);
                    }
                } else {
                    console.log(`ℹ️ No active referrals found for task ${task.task_type}`);
                    
                    const { error: updateError } = await supabase
                        .from('task_center')
                        .update({ 
                            current_count: 0,
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', task.id);
                }

            } catch (activeError) {
                console.error(`❌ Error processing active_ref task ${task.task_type}:`, activeError);
            }
        }

        // ПЕРЕЗАГРУЖАЕМ ДАННЫЕ
        const { data: updatedTasks, error: reloadError } = await supabase
            .from('task_center')
            .select('*')
            .eq('user_id', tcCurrentUser.id);

        if (!reloadError) {
            tcTaskData = updatedTasks;
            console.log('🔄 Reloaded task data:', tcTaskData);
        } else {
            console.error('❌ Error reloading task data:', reloadError);
        }

    } catch (error) {
        console.error('❌ Update counters error:', error);
    }
}

// 🚨 УЛЬТИМАТИВНЫЙ ФИКС - РАБОТАЕТ В 100% СЛУЧАЕВ
async function tcUltimateFix() {
    try {
        console.log('🚨 ULTIMATE FIX: Resetting ALL completed but unclaimed tasks...');
        const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        
        // Получаем СВЕЖИЕ данные из БД
        const { data: freshTasks, error: fetchError } = await supabase
            .from('task_center')
            .select('*')
            .eq('user_id', tcCurrentUser.id);

        if (fetchError) {
            console.error('❌ Error fetching fresh tasks:', fetchError);
            return;
        }

        console.log('🔍 Analyzing', freshTasks.length, 'tasks for ultimate fix...');

        let resetCount = 0;
        const tasksToReset = [];

        // Анализируем каждую задачу
        for (const task of freshTasks) {
            const config = TC_TASK_CONFIG[task.task_type];
            if (!config) continue;

            const requiredCount = config.required_count || 1;
            
            console.log(`📊 ${task.task_type}: ${task.current_count}/${requiredCount}, claimed: ${task.claimed}`);
            
            // 🎯 КРИТЕРИЙ ФИКСА: задача выполнена, но помечена как полученная
            if (task.current_count >= requiredCount && task.claimed) {
                console.warn(`⚠️ NEEDS FIX: ${task.task_type} - completed but claimed=true`);
                tasksToReset.push(task.task_type);
            }
        }

        // Применяем фикс ко всем проблемным задачам
        for (const taskType of tasksToReset) {
            console.log(`🔧 Resetting task: ${taskType}`);
            
            const { error: updateError } = await supabase
                .from('task_center')
                .update({ 
                    claimed: false,
                    updated_at: new Date().toISOString()
                })
                .eq('user_id', tcCurrentUser.id)
                .eq('task_type', taskType);

            if (updateError) {
                console.error(`❌ Error resetting ${taskType}:`, updateError);
            } else {
                console.log(`✅ Successfully reset ${taskType}`);
                resetCount++;
            }
        }

        if (resetCount > 0) {
            console.log(`🎉 ULTIMATE FIX: Reset ${resetCount} tasks`);
            // ПЕРЕЗАГРУЖАЕМ данные после фикса
            await tcLoadTaskProgress();
        } else {
            console.log('ℹ️ No tasks needed resetting');
        }

    } catch (error) {
        console.error('❌ Ultimate fix error:', error);
    }
}

function tcUpdateTaskUI() {
    if (!tcTaskData || tcTaskData.length === 0) {
        console.log('ℹ️ No task data to update UI');
        return;
    }

    console.log('🎨 Updating task UI...');
    
    tcTaskData.forEach(task => {
        const claimBtn = document.querySelector(`[data-task="${task.task_type}"]`);
        if (!claimBtn) {
            console.log(`❌ Button not found for task: ${task.task_type}`);
            return;
        }
        
        const taskElement = claimBtn.closest('.tc-task-item-compact');
        const progressText = taskElement.querySelector('.tc-progress-text');
        const progressFill = taskElement.querySelector('.tc-progress-fill');
        
        const config = TC_TASK_CONFIG[task.task_type];
        const requiredCount = config.required_count || 1;
        const progress = Math.min((task.current_count / requiredCount) * 100, 100);
        
        console.log(`📊 Task ${task.task_type}: ${task.current_count}/${requiredCount} (${progress}%) - Claimed: ${task.claimed}`);
        
        progressFill.style.width = `${progress}%`;
        
        if (task.task_type.startsWith('deposit')) {
            if (task.claimed) {
                progressText.textContent = '✅ Выполнено';
            } else if (task.current_count >= 1) {
                progressText.textContent = `✅ ${task.current_count} реферал(ов) пополнили`;
            } else {
                progressText.textContent = '⏳ Ожидание депозитов';
            }
        } else {
            progressText.textContent = `${task.current_count}/${requiredCount} активных рефералов`;
        }
        
        if (task.claimed) {
            claimBtn.disabled = true;
            claimBtn.innerHTML = '<i class="fas fa-check"></i>';
            claimBtn.style.background = '#28a745';
            taskElement.classList.add('tc-completed');
        } else if (task.current_count >= requiredCount) {
            claimBtn.disabled = false;
            claimBtn.innerHTML = '<i class="fas fa-gift"></i>';
            claimBtn.style.background = '#ff6b35';
            taskElement.classList.add('tc-available');
        } else {
            claimBtn.disabled = true;
            claimBtn.innerHTML = '<i class="fas fa-gift"></i>';
            claimBtn.style.background = '#6c757d';
            taskElement.classList.remove('tc-available', 'tc-completed');
        }
    });
    
    console.log('✅ Task UI updated');
}

function tcSetupEventListeners() {
    console.log('🔗 Setting up event listeners...');
    
    document.querySelectorAll('.tc-task-claim-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const taskType = this.getAttribute('data-task');
            console.log(`🎁 Claiming bonus for task: ${taskType}`);
            tcClaimTaskBonus(taskType);
        });
    });

    document.addEventListener('languageChanged', function() {
        console.log('🌐 Language changed, updating UI...');
        tcUpdateTaskUI();
        if (tcUserData) {
            document.getElementById('balance-display').textContent = (tcUserData.balance || 0).toFixed(2) + ' USDT';
        }
    });
    
    console.log('✅ Event listeners set up');
}

async function tcClaimTaskBonus(taskType) {
    try {
        console.log(`💰 Starting bonus claim for: ${taskType}`);
        
        const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        const task = tcTaskData.find(t => t.task_type === taskType);
        
        if (!task) {
            alert('❌ Задача не найдена');
            return;
        }
        
        if (task.claimed) {
            alert('✅ Бонус уже получен');
            return;
        }

        const config = TC_TASK_CONFIG[taskType];
        const requiredCount = config.required_count || 1;
        
        if (task.current_count < requiredCount) {
            alert('❌ Условия задачи еще не выполнены');
            return;
        }

        const newBalance = (tcUserData.balance || 0) + task.bonus_amount;
        
        console.log(`💸 Adding bonus: ${task.bonus_amount} USDT. New balance: ${newBalance}`);
        
        const updateData = {
            balance: newBalance,
            updated_at: new Date().toISOString()
        };
        
        if (tcUserData.total_profit !== undefined) {
            updateData.total_profit = (tcUserData.total_profit || 0) + task.bonus_amount;
        }
        
        const { error: updateError } = await supabase
            .from('users')
            .update(updateData)
            .eq('id', tcCurrentUser.id);

        if (updateError) {
            console.error('Update user error:', updateError);
            const { error: retryError } = await supabase
                .from('users')
                .update({ 
                    balance: newBalance,
                    updated_at: new Date().toISOString()
                })
                .eq('id', tcCurrentUser.id);
                
            if (retryError) throw retryError;
        }

        const { error: taskError } = await supabase
            .from('task_center')
            .update({ claimed: true })
            .eq('id', task.id);

        if (taskError) throw taskError;

        await supabase
            .from('transactions')
            .insert([
                {
                    user_id: tcCurrentUser.id,
                    type: 'task_bonus',
                    amount: task.bonus_amount,
                    description: `Бонус за выполнение задачи: ${taskType}`,
                    status: 'completed',
                    created_at: new Date().toISOString()
                }
            ]);

        tcUserData.balance = newBalance;
        if (tcUserData.total_profit !== undefined) {
            tcUserData.total_profit += task.bonus_amount;
        }
        
        document.getElementById('balance-display').textContent = newBalance.toFixed(2) + ' USDT';

        const claimBtn = document.querySelector(`[data-task="${taskType}"]`);
        claimBtn.classList.add('tc-claim-animation');
        setTimeout(() => claimBtn.classList.remove('tc-claim-animation'), 1000);

        await tcLoadTaskProgress();
        
        alert(`🎉 Поздравляем! Вы получили бонус: ${task.bonus_amount} USDT`);

    } catch (error) {
        console.error('❌ Claim bonus error:', error);
        alert('❌ Ошибка при получении бонуса: ' + error.message);
    }
}

async function tcAutoCheckAndClaim() {
    try {
        console.log('🤖 Starting auto-check and claim...');
        
        if (!tcTaskData || tcTaskData.length === 0) {
            console.log('ℹ️ No task data for auto-claim');
            return;
        }
        
        let claimedCount = 0;
        
        for (const task of tcTaskData) {
            const config = TC_TASK_CONFIG[task.task_type];
            const requiredCount = config.required_count || 1;
            
            if (!task.claimed && task.current_count >= requiredCount) {
                console.log(`🤖 Auto-claiming task: ${task.task_type}`);
                await tcClaimTaskBonus(task.task_type);
                claimedCount++;
            }
        }
        
        if (claimedCount > 0) {
            console.log(`✅ Auto-claimed ${claimedCount} tasks`);
        } else {
            console.log('ℹ️ No tasks ready for auto-claim');
        }
    } catch (error) {
        console.error('❌ Auto-claim error:', error);
    }
}

const style = document.createElement('style');
style.textContent = `
    .tc-claim-animation {
        animation: pulse 0.5s ease-in-out 3;
        transform: scale(1.1);
    }
    
    @keyframes pulse {
        0% { transform: scale(1); }
        50% { transform: scale(1.2); }
        100% { transform: scale(1); }
    }
    
    .tc-completed {
        opacity: 0.8;
        background: linear-gradient(135deg, #28a74520, #20c99720) !important;
    }
    
    .tc-available {
        background: linear-gradient(135deg, #ff6b3520, #fd7e1420) !important;
        border-left: 4px solid #ff6b35 !important;
    }
    
    .tc-task-claim-btn:disabled {
        cursor: not-allowed;
        opacity: 0.6;
    }
    
    .tc-task-claim-btn:not(:disabled):hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(255, 107, 53, 0.4);
    }
`;
document.head.appendChild(style);
